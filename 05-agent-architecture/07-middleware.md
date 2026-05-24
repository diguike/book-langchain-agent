---
title: Middleware 系统
feishu_url: "https://www.feishu.cn/wiki/JfoywJRA2i4ZXok3wloc4qRunuc"
last_synced: "2026-05-25T02:40:15+08:00"
---

> 模块 05 - Agent 架构 | 前置知识：[createAgent 入门](./01-create-agent.md)

## Middleware 是什么

Middleware 是 LangChain.js 1.x 的核心新概念。一句话定义：**Middleware 是在 Agent 的 model 调用和 tool 调用周围注入逻辑的统一接口**。

更具体的，Middleware 接口暴露四个钩子点：

```
┌─────────────────────────────────────┐
│         beforeModel(state)          │  在调用模型之前
├─────────────────────────────────────┤
│         model 节点                   │
├─────────────────────────────────────┤
│         afterModel(state)           │  在调用模型之后
├─────────────────────────────────────┤
│  （如果有 tool_calls，进入 tool 循环）  │
├─────────────────────────────────────┤
│         wrapModelCall(handler)      │  完全包裹模型调用
├─────────────────────────────────────┤
│         wrapToolCall(handler)       │  完全包裹工具调用
└─────────────────────────────────────┘
```

`beforeModel` 和 `afterModel` 是观察 + 轻量修改（改 state）。`wrapModelCall` 和 `wrapToolCall` 是完全接管：你可以重试、缓存、改返回值、决定不调下游。

## 为什么需要 middleware

考虑五个真实需求：

1. **审计日志**：每次模型调用前后记录 prompt、token 用量、耗时
2. **PII 脱敏**：模型调用前把用户消息里的手机号、邮箱替换成占位符，调用后还原
3. **速率限制**：在用户超过 token 配额时阻断调用
4. **响应缓存**：相同 prompt 直接返回缓存结果，跳过模型
5. **动态系统提示**：根据当前用户身份（pro/free）切换不同的 systemPrompt

这五个需求都不属于业务逻辑，但又必须在 Agent 的某一步精确介入。Middleware 把它们统一到一个接口，让审计、限流、缓存、动态提示这些横切关注点和业务工具彻底分开。

## 第一个 Middleware：审计日志

```typescript
import { createAgent } from "langchain";
import { createMiddleware } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

// 定义一个日志 middleware
const auditMiddleware = createMiddleware({
  name: "audit",
  // 在模型调用前打点
  async beforeModel(state, runtime) {
    const lastUserMsg = state.messages.findLast((m) => m._getType() === "human");
    console.log(`[audit] user request: ${lastUserMsg?.content}`);
    console.log(`[audit] thread_id: ${runtime.config.configurable?.thread_id}`);
  },
  // 在模型调用后打点
  async afterModel(state, runtime) {
    const lastAiMsg = state.messages.at(-1);
    const tokenUsage = lastAiMsg?.response_metadata?.usage;
    console.log(`[audit] tokens used: ${JSON.stringify(tokenUsage)}`);
  },
});

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [],
  systemPrompt: "你是一个助手",
  middleware: [auditMiddleware],
});

await agent.invoke({
  messages: [{ role: "user", content: "你好" }],
});
```

`beforeModel` 和 `afterModel` 拿到的 `state` 是只读的（修改不会传出去），但你可以 `return` 一个新的部分 state 来更新：

```typescript
beforeModel: async (state) => {
  // 返回新的 state 片段，会被合并到全局 state
  return {
    messages: [...state.messages, { role: "system", content: "动态注入的提示" }],
  };
},
```

## 用 `wrapModelCall` 实现响应缓存

`beforeModel` / `afterModel` 不能跳过模型调用。如果想"命中缓存就直接返回，不调模型"，得用 `wrapModelCall`：

```typescript
import crypto from "node:crypto";

const cache = new Map<string, any>();

const cacheMiddleware = createMiddleware({
  name: "cache",
  async wrapModelCall(handler, request) {
    // request 包含将要发给模型的所有信息
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify(request.messages))
      .digest("hex");

    if (cache.has(key)) {
      console.log(`[cache] HIT ${key.slice(0, 8)}`);
      return cache.get(key);
    }

    // 调用下游（真实的模型调用）
    const response = await handler(request);

    cache.set(key, response);
    console.log(`[cache] MISS ${key.slice(0, 8)}`);
    return response;
  },
});
```

`wrapModelCall` 是经典的洋葱模型：拿到 `handler`，决定要不要调它，或者怎么调它。多个 middleware 的 `wrapModelCall` 会依次嵌套，**注册顺序越靠前的越在外层**。

## 内置 Middleware

LangChain.js 1.x 自带几个常用 middleware，直接 import 就用：

### `dynamicSystemPromptMiddleware`

根据运行时 `context` 切换 systemPrompt：

```typescript
import { dynamicSystemPromptMiddleware } from "langchain";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [],
  middleware: [
    dynamicSystemPromptMiddleware((state, runtime) => {
      const tier = runtime.context.userTier as "pro" | "free";
      if (tier === "pro") {
        return "你是 Pro 用户的助手，可以使用所有工具，回答可以详细。";
      }
      return "你是免费用户的助手，只能回答基本问题。";
    }),
  ],
});

// 调用时传 context
await agent.invoke(
  { messages: [{ role: "user", content: "..." }] },
  { context: { userTier: "pro" } }
);
```

这种动态 prompt 写法可以读 `runtime.context`、可以异步、可以读其他 state，比直接在 `systemPrompt` 里写死灵活得多。

### `todoListMiddleware`

让 Agent 在长任务中维护一个 TODO list：

```typescript
import { todoListMiddleware } from "langchain";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-opus-4-7" }),
  tools: [/* ... */],
  middleware: [todoListMiddleware()],
});
```

启用后，Agent 会自动获得一个 `write_todos` 工具，被鼓励在每一步推理时更新 TODO，可观察性大幅提升。适合 5+ 步骤的复杂任务（如代码生成、报告撰写、多轮研究）。

## 用 `wrapToolCall` 做工具级错误处理

工具失败的默认处理是把异常当成一条 ToolMessage 回灌给模型，让模型自己决定怎么办。但有些场景你想干预——比如指数退避重试、把特定异常转成业务错误码：

```typescript
const retryToolMiddleware = createMiddleware({
  name: "retry-tool",
  async wrapToolCall(handler, request) {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await handler(request);
      } catch (err) {
        lastError = err;
        const delay = 2 ** attempt * 100;
        console.log(`[retry-tool] ${request.tool} attempt ${attempt} failed, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // 重试用尽，把异常转成一条结构化消息回灌
    return {
      role: "tool",
      tool_call_id: request.tool_call_id,
      content: `Tool ${request.tool} failed after ${maxAttempts} attempts: ${String(lastError)}`,
    };
  },
});
```

## 自定义 state schema（带 stateSchema 的 middleware）

Middleware 可以扩展 Agent 的全局 state：

```typescript
import { z } from "zod";

const billingMiddleware = createMiddleware({
  name: "billing",
  // 给 state 加一个新字段
  stateSchema: z.object({
    tokensUsedThisSession: z.number().default(0),
  }),
  async afterModel(state) {
    const lastAi = state.messages.at(-1);
    const used = lastAi?.response_metadata?.usage?.total_tokens ?? 0;
    return {
      tokensUsedThisSession: state.tokensUsedThisSession + used,
    };
  },
});
```

这样 `state` 在整个 Agent 生命周期里都能读到 `tokensUsedThisSession`，其他 middleware 也能用。

## 多个 Middleware 的组合顺序

注册顺序决定了执行顺序：

```typescript
createAgent({
  model,
  tools,
  middleware: [
    auditMiddleware,      // 1. 最外层
    cacheMiddleware,      // 2.
    rateLimitMiddleware,  // 3. 最内层（最贴近真实模型调用）
  ],
});
```

`beforeModel` 按 `audit → cache → rateLimit` 顺序触发；  
`afterModel` 按 `rateLimit → cache → audit` 顺序触发（**逆序**）；  
`wrapModelCall` 是洋葱嵌套，`audit` 在最外层，`rateLimit` 最贴近真实调用。

实际项目里推荐这个分层：

```
顶层（最外）：审计日志、监控
中层：缓存、限流
底层（最内）：PII 脱敏、token 计费
```

## 一个完整的生产 Middleware Stack

把上面几个组合起来，做一个生产可用的 Agent：

```typescript
import { createAgent, createMiddleware, dynamicSystemPromptMiddleware } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const stack = [
  // 1. 审计
  createMiddleware({
    name: "audit",
    async beforeModel(state, runtime) {
      console.log(`[audit] ${new Date().toISOString()} request from ${runtime.context.userId}`);
    },
  }),

  // 2. 速率限制
  createMiddleware({
    name: "rate-limit",
    async beforeModel(state, runtime) {
      const userId = runtime.context.userId as string;
      const allowed = await checkRateLimit(userId);
      if (!allowed) {
        throw new Error(`rate limit exceeded for user ${userId}`);
      }
    },
  }),

  // 3. 动态提示
  dynamicSystemPromptMiddleware((state, runtime) => {
    const tier = runtime.context.userTier as string;
    return tier === "pro"
      ? "你是 Pro 用户的助手，可以调用全部工具。"
      : "你是免费用户的助手，仅能回答常识。";
  }),
];

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  middleware: stack,
});

await agent.invoke(
  { messages: [{ role: "user", content: "..." }] },
  { context: { userId: "u_123", userTier: "pro" } }
);

async function checkRateLimit(userId: string): Promise<boolean> {
  // 真实场景接 Redis 或自己的 quota 服务
  return true;
}
```

## 何时不该用 middleware

Middleware 是强大的"切面"工具，但有两种情况不该用：

1. **业务逻辑本身**：业务逻辑应该在 tool 里实现，不要塞进 middleware。Middleware 是 cross-cutting concerns（横切关注点），不是业务流程
2. **替代 LangGraph 的拓扑设计**：如果你需要"先调 A，再根据 A 的结果决定调 B 还是 C"，这是图拓扑，应该用 [LangGraph](./03-langgraph-intro.md) 直接画图，不要在 middleware 里塞 if-else

## 小结

Middleware 是 1.x Agent 系统的 cross-cutting 接口，提供四个钩子：`beforeModel` / `afterModel` / `wrapModelCall` / `wrapToolCall`。内置了 `dynamicSystemPromptMiddleware` 和 `todoListMiddleware` 等开箱即用的实现。生产环境用 middleware 处理审计、限流、缓存、动态提示等横切关注点。

下一节 [Multi-Agent 协作](./08-multi-agent.md) 把多个 Agent 串起来构成更大的系统。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
