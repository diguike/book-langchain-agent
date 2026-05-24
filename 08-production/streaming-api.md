---
title: 流式接口部署
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/TymQwIIZqizPpnkGXSzcO4lZnyg"
last_synced: "2026-05-25T02:43:10+08:00"
---

> 模块 08 - 生产部署 | 前置知识：[流式输出深入](../05-agent-architecture/stream-modes.md)、[API 服务化](./api-server.md)

## 这一节讲什么、不讲什么

[流式输出深入](../05-agent-architecture/stream-modes.md) 讲了 `stream()` 和 `streamEvents()` 这两个 API 怎么用、5 种 stream mode 各推什么数据。那一节是"API 视角"。

这一节是"部署视角"——同样的 `stream({ streamMode: "messages", encoding: "text/event-stream" })`，扔到生产环境后面对的是另一套问题：

- Nginx / Cloudflare 反代会不会把流缓冲住
- 浏览器 EventSource API 的 POST 限制怎么绕开
- 客户端断网 / 切 tab 怎么及时清理
- 长连接负载均衡需不需要 sticky session
- 跟 WebSocket 比，什么时候用 WS 而非 SSE
- 移动端 / 弱网下流式怎么稳

API 写法不重复，直接给生产配置和踩过的坑。

## SSE 还是 WebSocket：90% 选 SSE

[流式输出深入](../05-agent-architecture/stream-modes.md) 末尾已经给过一张对比表，这里把生产视角的决策再说一遍。

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 协议 | HTTP/1.1 + HTTP/2 | 独立协议（升级握手） |
| 通信方向 | 服务端 → 客户端单向 | 双向 |
| 反代友好度 | 标准 HTTP，Nginx / Cloudflare / API 网关原生支持 | 需要显式配置 upgrade header |
| 自动重连 | 浏览器 `EventSource` 内置 | 自己实现 |
| 客户端复杂度 | 低（`fetch + ReadableStream`） | 中（连接 / 心跳 / 重连状态机） |
| 鉴权 | HTTP header / cookie 自然带 | 握手时拼到 URL query 或子协议里 |
| 移动端友好度 | 好 | 受弱网影响大 |

**LLM 流式 90% 选 SSE 的理由**：用户提交一句话 → 服务端流式吐 token → 完成断开。这本质是请求-响应（单向 push），SSE 完全够用。WS 的双向能力你用不上，反而要自己处理一堆状态。

什么时候真要 WS？只有当**用户在生成过程中需要打断当前回复、追加上下文、控制 Agent 行为**这种交互模式时——比如交互式编程助手，用户边看代码生成边按 Esc 取消。这种场景 WS 的双向通道才真有必要。

## SSE 协议长什么样

SSE 是文本协议，简单到一眼能看完：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

event: on_chat_model_stream
data: {"chunk":{"contentBlocks":[{"type":"text","text":"你"}]}}

event: on_chat_model_stream
data: {"chunk":{"contentBlocks":[{"type":"text","text":"好"}]}}

event: done
data: {"status":"complete"}

```

每条事件是 `event: <name>\ndata: <json>\n\n` 的格式，以空行分隔。LangGraph 1.x 的 `stream({ encoding: "text/event-stream" })` 直接产出符合这个格式的 `ReadableStream<Uint8Array>`，不需要手写拼接。

## 服务端：最小可上线的 SSE 接口

[API 服务化](./api-server.md) 已经给过一个最简版本，这里把生产细节补全：

```typescript
// src/routes/chat-stream.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { agent } from "../lib/agent";

const stream = new Hono();

const StreamBody = z.object({
  message: z.string().min(1).max(10_000),
  threadId: z.string().uuid().optional(),
});

stream.post("/chat/stream", zValidator("json", StreamBody), async (c) => {
  const body = c.req.valid("json");

  // 关键 1：客户端断开时 abort
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => {
    console.log("[sse] client disconnected, aborting agent");
    abortController.abort();
  });

  // 关键 2：用 LangGraph 原生 SSE 编码
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

  // 关键 3：必须的响应头
  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",        // Nginx 禁缓冲
      "Connection": "keep-alive",
    },
  });
});

export default stream;
```

四个生产必备 header 单独拎出来讲：

| Header | 作用 |
|--------|------|
| `Content-Type: text/event-stream` | 协议标识 |
| `Cache-Control: no-cache, no-transform` | 禁缓存，防中间代理改协议 |
| `X-Accel-Buffering: no` | Nginx 禁 proxy_buffering（针对单个响应） |
| `Connection: keep-alive` | 长连接 |

少一个都可能出"客户端等了 10 秒后突然一次性收到全部 token"这种问题。

## Nginx 反代配置

Nginx 默认会缓冲后端响应——对普通 API 是优化，对 SSE 是灾难。要显式关掉：

```nginx
# /etc/nginx/conf.d/agent.conf
upstream agent_backend {
    least_conn;                          # 长连接场景用最少连接策略
    server 10.0.0.1:3000 max_fails=3;
    server 10.0.0.2:3000 max_fails=3;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    location /api/v1/chat/stream {
        proxy_pass http://agent_backend;
        proxy_http_version 1.1;

        # SSE 关键配置
        proxy_buffering off;             # 禁缓冲
        proxy_cache off;                 # 禁缓存
        proxy_read_timeout 300s;         # 长连接超时（按业务最长响应时间设）
        proxy_send_timeout 300s;

        # 透传必要 header
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关掉响应缓冲（HTTP/2 场景特别重要）
        chunked_transfer_encoding on;
    }

    # 其他 API 走默认配置
    location /api/v1/ {
        proxy_pass http://agent_backend;
        proxy_set_header Host $host;
    }
}
```

`proxy_read_timeout` 要大于 Agent 最长执行时间。Agent 跑 60 秒还没结束 Nginx 就主动断了，前端看到的是"突然没消息了"。

## Cloudflare 反代配置

Cloudflare Free / Pro plan 默认会把 HTTP response 缓冲到一定大小才转发，对 SSE 致命。三个要点：

1. **DNS 记录设成 DNS Only**（灰云）：跳过 Cloudflare 代理。简单粗暴，但失去 DDoS 防护
2. **走 Cloudflare Workers**：在 Worker 里做 fetch + transform，原生支持 streaming
3. **用 Page Rules / Cache Rules**：Bypass Cache + Origin Cache Control: respect

推荐第二种——Worker 做一层薄薄的转发，把 stream 透传：

```typescript
// cloudflare-worker.ts
export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/v1/chat/stream")) {
      // 直接 fetch origin，把 ReadableStream 透传
      const originUrl = new URL(url.pathname + url.search, env.ORIGIN_URL);
      const resp = await fetch(originUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      // resp.body 是 ReadableStream，直接 return 即可，CF Worker 不会缓冲
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    // 其他路径默认转发
    return fetch(new URL(url.pathname + url.search, env.ORIGIN_URL), req);
  },
};
```

如果用 Cloudflare Pages / Workers 直接部署 Agent（Hono 原生支持），就不存在反代问题。

## 客户端：浏览器消费 SSE

浏览器原生 `EventSource` API 只支持 GET 请求且没有自定义 header 能力——做 LLM 应用通常要 POST + Authorization header，所以基本都用 `fetch + ReadableStream` 而非 `EventSource`：

```typescript
// client/sse-client.ts
export async function streamChat(
  message: string,
  onToken: (text: string) => void,
  onDone: () => void,
  signal?: AbortSignal
) {
  const resp = await fetch("/api/v1/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": getApiKey(),
    },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以双换行分隔
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? ""; // 留下不完整的最后一段

    for (const evt of events) {
      if (!evt.trim()) continue;
      // 解析 event 和 data 行
      let eventName = "message";
      let data = "";
      for (const line of evt.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;

      try {
        const payload = JSON.parse(data);
        if (eventName === "on_chat_model_stream") {
          // LangGraph 用 contentBlocks 表示多模态
          const text = payload.chunk?.contentBlocks
            ?.filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("") ?? "";
          if (text) onToken(text);
        } else if (eventName === "done") {
          onDone();
        }
      } catch (e) {
        console.warn("[sse] parse error", e);
      }
    }
  }

  onDone();
}
```

React 组件包一层：

```tsx
import { useState, useCallback, useRef } from "react";
import { streamChat } from "./sse-client";

export function ChatBox() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setOutput("");
    abortRef.current = new AbortController();

    try {
      await streamChat(
        input,
        (token) => setOutput((prev) => prev + token),
        () => setBusy(false),
        abortRef.current.signal
      );
    } catch (e: any) {
      if (e.name !== "AbortError") console.error(e);
      setBusy(false);
    }
  }, [input, busy]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={send} disabled={busy}>发送</button>
      <button onClick={stop} disabled={!busy}>停止</button>
      <div style={{ whiteSpace: "pre-wrap" }}>{output}</div>
    </div>
  );
}
```

"停止"按钮触发 `AbortController.abort()`，会同时：

1. 中断 fetch 的 reader
2. 在 server 端触发 `c.req.raw.signal` 的 abort 事件
3. 服务端的 `agentController.abort()` 停止 Agent 循环

整条链路干净退出，不浪费 token。

## 客户端：移动端 / 弱网

移动端的 SSE 实战坑：

**1. 切到后台后连接被系统断开**

iOS Safari / Chrome 锁屏几分钟后会暂停所有 fetch。回前台时连接已经死了但 `reader.read()` 不会立刻报错——会卡着。

应对：服务端定期发心跳，客户端如果一段时间没收到任何事件就主动重连：

```typescript
// 服务端：每 15 秒发一个心跳事件
// 在 LangGraph 1.x 里可以用 dispatchCustomEvent 发，或者直接在 Hono 路由里用 streamSSE 包一层手动发
```

LangGraph 的 `stream()` 不会内置心跳。如果你想要心跳，可以用 Hono 的 `streamSSE` helper 自己管理。

跟前面 ReadableStream + `streamMode: "messages-tuple"` 的主路径不同，下面这段刻意不用 encoding 选项，而是手动遍历 `agent.stream()` 逐 token 写入 SSE——目的就是要在主循环里插入定时心跳，控制权得在自己手里：

```typescript
import { streamSSE } from "hono/streaming";

stream.post("/chat/stream-with-heartbeat", async (c) => {
  return streamSSE(c, async (sse) => {
    const heartbeat = setInterval(() => {
      sse.writeSSE({ event: "heartbeat", data: String(Date.now()) }).catch(() => {});
    }, 15_000);

    try {
      const agentStream = await agent.stream(input, { streamMode: "messages" });
      for await (const [chunk, meta] of agentStream) {
        const text = chunk.contentBlocks
          ?.filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("") ?? "";
        if (text) {
          await sse.writeSSE({ event: "token", data: JSON.stringify({ text }) });
        }
      }
      await sse.writeSSE({ event: "done", data: "{}" });
    } finally {
      clearInterval(heartbeat);
    }
  });
});
```

**2. HTTP/2 多路复用 vs HTTP/1.1 连接数限制**

HTTP/1.1 每个域名最多 6 个并发连接。一个 SSE 长连接占一个，剩 5 个给其他请求——同一个用户开多个 tab 容易爆。

应对：用 HTTP/2（Nginx `listen 443 ssl http2`），SSE 不占用连接配额。或者 SSE 走子域名 `stream.example.com` 跟主 API 域名分开。

## 负载均衡：要不要 sticky session

LangGraph 1.x 用 checkpointer 持久化对话（Postgres / Redis），同一个 `thread_id` 不依赖落到哪个进程——任意 pod 都能从 checkpointer 读出历史继续。

**结论：如果你用了 Postgres / Redis 作 checkpointer，不需要 sticky session**。

唯一需要 sticky 的场景：你用 `MemorySaver`（in-process memory），那 thread 只在当前 pod 内有效。这种部署模式不能水平扩，不推荐生产用。

## WebSocket 备选方案

少数场景要双向通信。WS 用 Hono + `ws` 库（Node.js）或 Hono 内置 helper（Bun / CF Workers）：

```typescript
// Node.js + ws 库
import { WebSocketServer } from "ws";
import { agent } from "./lib/agent";

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  let currentAbort: AbortController | null = null;

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "user_message") {
      currentAbort = new AbortController();
      try {
        const stream = await agent.stream(
          { messages: [{ role: "user", content: msg.content }] },
          { streamMode: "messages", signal: currentAbort.signal }
        );
        for await (const [chunk, meta] of stream) {
          const text = chunk.contentBlocks
            ?.filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("") ?? "";
          if (text) ws.send(JSON.stringify({ type: "token", text }));
        }
        ws.send(JSON.stringify({ type: "done" }));
      } catch (e: any) {
        if (e.name !== "AbortError") {
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        }
      }
    } else if (msg.type === "cancel") {
      currentAbort?.abort();
    }
  });

  ws.on("close", () => currentAbort?.abort());
});
```

客户端：

```typescript
const ws = new WebSocket("wss://api.example.com/ws");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "token") appendToUI(msg.text);
};
ws.send(JSON.stringify({ type: "user_message", content: "你好" }));
// 用户按 Esc 时
ws.send(JSON.stringify({ type: "cancel" }));
```

注意 WS 鉴权：握手是普通 HTTP 升级请求，可以带 cookie 或 query 参数 token，但浏览器 `WebSocket` 构造器不支持设自定义 header——通常做法是把 token 放在 URL（`wss://...?token=xxx`）或第一条消息里。

## 反向代理 WebSocket（Nginx）

```nginx
location /ws/ {
    proxy_pass http://agent_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

`Upgrade` + `Connection: upgrade` 这两个 header 不能漏，否则 Nginx 会按普通 HTTP 处理握手会失败。

## 实战总结

我自己生产部署 LLM 流式接口的 checklist：

- [ ] 优先 SSE，理由前面给过
- [ ] 服务端用 `agent.stream({ streamMode: "messages", encoding: "text/event-stream" })`
- [ ] 设 `X-Accel-Buffering: no` 和 `Cache-Control: no-cache, no-transform`
- [ ] 服务端响应 Nginx 关 `proxy_buffering`，超时设大
- [ ] 客户端用 `fetch + ReadableStream` 而非 `EventSource`（POST + auth header）
- [ ] 客户端 abort 一定要传到服务端（`AbortController` 链路）
- [ ] 心跳：15 秒一次，移动端必需
- [ ] HTTP/2 启用，规避连接数限制
- [ ] 用 Postgres / Redis checkpointer 避免 sticky session
- [ ] LangSmith trace 把 `runName: "ChatStream"` 打上，方便排查

只有需要"用户在生成中打断追加上下文"这种交互时才上 WS。

## 小结

LangGraph 1.x 的 `stream({ encoding: "text/event-stream" })` 让 SSE 服务端变成几行代码的事，但生产部署的难点在反向代理、客户端断开处理、移动端心跳、连接复用这些"管子里"的问题。Nginx / Cloudflare 配置不对会让流式变成假流式（全部攒到结尾才返回）；客户端不传 abort 会让 Agent 跑空圈烧 token；多副本部署用 in-process memory 会导致 thread 漂移。把这一节的 checklist 过一遍能避开 95% 的线上坑。

下一节 [缓存与成本优化](./caching-cost.md) 讲怎么用 semantic cache + prompt cache + 模型路由把 token 账单砍掉一半。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
