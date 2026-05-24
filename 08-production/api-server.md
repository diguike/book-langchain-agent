---
title: API 服务化
feishu_url: ""
last_synced: ""
---

> 模块 08 - 生产部署 | 前置知识：[createAgent 入门](../05-agent-architecture/create-agent.md)、[流式输出深入](../05-agent-architecture/stream-modes.md)

## 把 Agent 包成 HTTP 服务

写完 Agent 之后下一步：包成一个能被前端、移动端、其他服务调用的 HTTP API。这一节用 [Hono](https://hono.dev/) 搭一个生产可用的服务，包括同步接口、SSE 流式接口、请求验证、错误处理。

为什么用 Hono？

- 体积小（~12kb），冷启动快
- TypeScript 优先，类型推导完整
- 同一份代码能跑在 Node.js / Bun / Cloudflare Workers / Vercel Edge
- 内置 SSE / WebSocket helper

Express 也行，写法略不同；本节末尾会给一个 Express 等价示例。

## 项目结构

```
src/
├── index.ts              # 入口，挂中间件 + 路由
├── routes/
│   ├── chat.ts           # 同步对话接口
│   ├── chat-stream.ts    # SSE 流式接口
│   └── health.ts         # 健康检查
├── lib/
│   ├── agent.ts          # Agent 单例
│   ├── validation.ts     # Zod schema
│   └── env.ts            # 环境变量校验
└── middleware/
    ├── auth.ts
    ├── rate-limit.ts
    └── error.ts
```

## Agent 单例与冷启动

Agent 创建本身不重，但 model client 内部有连接池、warm-up。一个 process 内复用同一个 Agent 实例：

```typescript
// src/lib/agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async ({ city }) => {
    // 真实场景调天气 API
    return `${city} 22°C，多云`;
  },
  {
    name: "get_weather",
    description: "查询某个城市的实时天气",
    schema: z.object({
      city: z.string().describe("城市名"),
    }),
  }
);

// 模块级单例 —— import 时初始化一次
export const agent = createAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-6",
    temperature: 0,
  }),
  tools: [getWeather],
  systemPrompt: "你是一个简洁的助手。涉及实时信息时必须用工具。",
});
```

Serverless 场景下每次冷启动会重建 agent，这是不可避免的；常驻进程（Docker / EC2）就完全没问题。

## 请求 Schema 与 Zod 验证

所有外部输入必须先过 schema。Zod 既做运行时验证又做 TS 类型推导：

```typescript
// src/lib/validation.ts
import { z } from "zod";

export const ChatRequest = z.object({
  message: z.string().min(1).max(10_000),
  threadId: z.string().uuid().optional(),     // 复用对话用
  metadata: z.record(z.string()).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequest>;

export const StreamRequest = ChatRequest;
```

`message` 强制非空 + 限长（防长消息攻击）。`threadId` 用于复用对话历史，配合 `checkpointer` 用。

## 同步对话接口

```typescript
// src/routes/chat.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { agent } from "../lib/agent";
import { ChatRequest } from "../lib/validation";

const chat = new Hono();

chat.post("/chat", zValidator("json", ChatRequest), async (c) => {
  const body = c.req.valid("json");

  const result = await agent.invoke(
    { messages: [{ role: "user", content: body.message }] },
    {
      configurable: body.threadId ? { thread_id: body.threadId } : undefined,
      metadata: body.metadata,
      runName: "ChatTurn",
    }
  );

  const lastMessage = result.messages.at(-1);

  return c.json({
    ok: true,
    data: {
      message: lastMessage?.content,
      threadId: body.threadId,
      steps: result.messages.length,
    },
  });
});

export default chat;
```

几个要点：

- `zValidator` 校验失败时自动返回 400，body 不合法不会进 handler
- `configurable.thread_id` 传给 LangGraph 的 checkpointer 复用历史
- `runName` 在 LangSmith 上做 trace 名字（参考 [LangSmith Tracing](../07-observability/langsmith-tracing.md)）

## SSE 流式接口

流式接口是另一个文件，因为响应模式完全不同。详细 SSE 部署细节在 [流式接口部署](./streaming-api.md)，这里给最小实现：

```typescript
// src/routes/chat-stream.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { agent } from "../lib/agent";
import { StreamRequest } from "../lib/validation";

const stream = new Hono();

stream.post("/chat/stream", zValidator("json", StreamRequest), async (c) => {
  const body = c.req.valid("json");

  const abortController = new AbortController();
  // 客户端断开就 abort，避免 Agent 跑完整个循环浪费 token
  c.req.raw.signal.addEventListener("abort", () => abortController.abort());

  // stream() 的 encoding 选项直接产出 SSE 格式的 ReadableStream
  const sseStream = await agent.stream(
    { messages: [{ role: "user", content: body.message }] },
    {
      streamMode: "messages",
      encoding: "text/event-stream",
      configurable: body.threadId ? { thread_id: body.threadId } : undefined,
      signal: abortController.signal,
      runName: "ChatStream",
    }
  );

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no", // Nginx 禁 buffering
    },
  });
});

export default stream;
```

注意这里直接用了 `stream({ encoding: "text/event-stream" })`——LangGraph 1.x 原生支持把流编码成 SSE，不需要手写 `\n\ndata:` 拼接。

## 鉴权中间件

最简单的 API Key 鉴权：

```typescript
// src/middleware/auth.ts
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

const VALID_KEYS = new Set(
  (process.env.API_KEYS ?? "").split(",").filter(Boolean)
);

export async function apiKeyAuth(c: Context, next: Next) {
  const apiKey =
    c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace("Bearer ", "");

  if (!apiKey) {
    throw new HTTPException(401, { message: "Missing API key" });
  }
  if (!VALID_KEYS.has(apiKey)) {
    throw new HTTPException(403, { message: "Invalid API key" });
  }

  c.set("apiKey", apiKey);
  await next();
}
```

JWT 鉴权用 Hono 内置 `jwt` 中间件：

```typescript
import { jwt } from "hono/jwt";

export const jwtAuth = jwt({
  secret: process.env.JWT_SECRET!,
});
```

生产中两种通常并存：B2B 用 API Key，C 端用 JWT。

## 限流

防止单用户耗尽你的 LLM 配额：

```typescript
// src/middleware/rate-limit.ts
import type { Context, Next } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";

// 单进程内存限流（多副本部署要换 RateLimiterRedis）
const limiter = new RateLimiterMemory({
  points: 30,       // 每个 key 允许 30 次
  duration: 60,     // 每 60 秒
});

export async function rateLimit(c: Context, next: Next) {
  const key =
    c.get("apiKey") ??
    c.req.header("X-Forwarded-For") ??
    c.req.header("CF-Connecting-IP") ??
    "anonymous";

  try {
    const res = await limiter.consume(key);
    c.header("X-RateLimit-Limit", "30");
    c.header("X-RateLimit-Remaining", String(res.remainingPoints));
    await next();
  } catch (rej: any) {
    c.header("Retry-After", String(Math.ceil(rej.msBeforeNext / 1000)));
    return c.json({ ok: false, error: "Too many requests" }, 429);
  }
}
```

多副本部署必须换 Redis 版本（`RateLimiterRedis`），否则限流不准。

## 错误处理

统一拦截各类错误：

```typescript
// src/middleware/error.ts
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export function errorHandler(err: Error, c: Context) {
  // Zod 验证错误（zValidator 抛出）
  if (err instanceof ZodError) {
    return c.json(
      {
        ok: false,
        error: "Validation failed",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
      400
    );
  }

  // Hono HTTP 异常（鉴权抛的 401/403 等）
  if (err instanceof HTTPException) {
    return c.json({ ok: false, error: err.message }, err.status);
  }

  // LLM provider 限流
  if (err.message?.includes("rate_limit") || err.message?.includes("429")) {
    return c.json(
      { ok: false, error: "Upstream LLM rate limit, please retry" },
      429
    );
  }

  // 上下文超长
  if (err.message?.includes("context") && err.message?.includes("length")) {
    return c.json({ ok: false, error: "Input too long" }, 400);
  }

  // 未知错误：日志记录详情，对外只暴露通用错误
  console.error("[unhandled]", err);
  return c.json({ ok: false, error: "Internal server error" }, 500);
}
```

**重要**：错误消息绝对不要透传给客户端原始内容。LLM provider 的错误里经常带 API Key 片段、上游 URL 等敏感信息，必须脱敏。详细的输出脱敏在 [安全防御](./security.md)。

## 健康检查

K8s / 容器编排靠两个探针：

```typescript
// src/routes/health.ts
import { Hono } from "hono";

const health = new Hono();

// Liveness：进程是否活着，不检查依赖
health.get("/health/live", (c) => {
  return c.json({ status: "ok", ts: Date.now() });
});

// Readiness：能否对外服务（依赖是否就绪）
health.get("/health/ready", async (c) => {
  const checks: Record<string, boolean> = {};

  // 检查 Anthropic 可达
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    // HEAD 返回 405 也算可达
    checks.anthropic = r.status > 0;
  } catch {
    checks.anthropic = false;
  }

  // 这里也可以加 Redis / Postgres 检查
  // checks.redis = await pingRedis();

  const allOk = Object.values(checks).every(Boolean);
  return c.json(
    { status: allOk ? "ready" : "not_ready", checks, ts: Date.now() },
    allOk ? 200 : 503
  );
});

export default health;
```

Liveness 失败 K8s 会重启 pod；Readiness 失败 K8s 会把 pod 从 Service 摘除但不重启。区分两者很重要。

## 完整入口

```typescript
// src/index.ts
import "dotenv/config";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";

import chat from "./routes/chat";
import stream from "./routes/chat-stream";
import health from "./routes/health";
import { apiKeyAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rate-limit";
import { errorHandler } from "./middleware/error";

const app = new Hono();

// 全局中间件
app.use("*", logger());
app.use("*", secureHeaders());
app.use(
  "*",
  cors({
    origin: (process.env.CORS_ORIGINS ?? "*").split(","),
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "X-API-Key", "Authorization"],
  })
);

// 健康检查不需要鉴权
app.route("/", health);

// API 路由统一鉴权 + 限流
const api = new Hono();
api.use("*", apiKeyAuth);
api.use("*", rateLimit);
api.route("/", chat);
api.route("/", stream);

app.route("/api/v1", api);

// 全局错误兜底
app.onError(errorHandler);

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`server listening on :${port}`);
serve({ fetch: app.fetch, port });
```

启动：

```bash
npm install hono @hono/node-server @hono/zod-validator \
  langchain @langchain/anthropic @langchain/core \
  rate-limiter-flexible zod dotenv

ANTHROPIC_API_KEY=sk-ant-xxx \
API_KEYS=test-key-1,test-key-2 \
npx tsx src/index.ts
```

测试：

```bash
# 同步
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key-1" \
  -d '{"message": "北京今天天气"}'

# 流式
curl -N -X POST http://localhost:3000/api/v1/chat/stream \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key-1" \
  -d '{"message": "北京今天天气"}'
```

## Express 等价示例

不熟悉 Hono 的话，Express 写法差不多：

```typescript
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { agent } from "./lib/agent";

const app = express();
app.use(express.json({ limit: "100kb" }));

const ChatBody = z.object({ message: z.string().min(1).max(10_000) });

app.post("/api/v1/chat", async (req, res, next) => {
  try {
    const body = ChatBody.parse(req.body);
    const result = await agent.invoke({
      messages: [{ role: "user", content: body.message }],
    });
    res.json({ ok: true, data: { message: result.messages.at(-1)?.content } });
  } catch (e) {
    next(e);
  }
});

app.listen(3000);
```

功能跟 Hono 版一致，少几行类型推导。

## 实战建议

- **请求 body 限大小**：`express.json({ limit: "100kb" })` 或 Hono 的 `bodyLimit`，防止超长 payload
- **超时设置**：HTTP server 超时 > Agent 最长执行时间（一般 30-60s），但要小于负载均衡器的超时（避免静默断开）
- **优雅退出**：进程收 SIGTERM 时先停止接收新请求、等 in-flight 请求完成、再关进程
- **日志结构化**：用 `pino` 或 `winston` 输出 JSON 日志，方便 ELK / Datadog 采集
- **不要把 stack trace 暴露给客户端**：开发环境可以，生产一律返回 generic error message

## 小结

把 Agent 包成 HTTP 服务的关键不是路由本身，而是配套的鉴权 / 限流 / 验证 / 错误处理 / 健康检查这一套基础设施。Hono 给的脚手架够好，单文件入口能跑、能上 Cloudflare Workers。同步接口用 `agent.invoke`，流式用 `agent.stream({ encoding: "text/event-stream" })`。

下一节 [流式接口部署](./streaming-api.md) 展开讲 SSE 在 Nginx / Cloudflare 后面的生产部署细节，以及 WebSocket 什么时候用得上。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
