---
title: 流式输出深入 Stream Modes 与 Events
feishu_url: "https://www.feishu.cn/wiki/BP71wWUVEi2RlLkk69BcjMMRn1e"
last_synced: "2026-05-25T02:40:19+08:00"
---

> 模块 05 - Agent 架构 | 前置知识：[createAgent 入门](./create-agent.md)、[LangGraph 入门](./langgraph-intro.md)

## 为什么单独讲一节流式

把 Agent 包成一个 HTTP 接口、做一个 ChatGPT 一样的实时打字效果，绕不开 LangGraph 的流式 API。这一节会拆透两套 API：

- `graph.stream(input, options)`：节点级流式，5 种 stream mode
- `graph.streamEvents(input, options)`：事件级流式，token 级别推送

`createAgent` 返回的 Agent 也是一个 graph，所以本节方法对它同样适用。

## 五种 stream mode

`stream()` 的 `streamMode` 选项决定推什么粒度的数据：

| Mode | 推什么 | 用在哪里 |
|------|--------|----------|
| `values` | 每次 state 更新后的**完整** state | 调试、状态可视化 |
| `updates` | 每个节点产出的**增量** state | 日志、审计、节点级监控 |
| `messages` | 模型 token 级流（message + metadata） | 聊天 UI |
| `debug` | 所有 internal 事件 + 节点输入输出 | 深度调试 |
| `custom` | 用户自定义事件（用 `dispatchCustomEvent`） | 业务级埋点 |

可以传多个：`streamMode: ["updates", "messages"]`，事件流里每个 chunk 带 `(mode, data)` 元组。

### `values`：完整快照

```typescript
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

for await (const snapshot of agent.stream(
  { messages: [{ role: "user", content: "..." }] },
  { streamMode: "values" }
)) {
  console.log("state snapshot:", snapshot);
  // snapshot.messages 是当前完整的消息列表
}
```

每次有节点完成，就推一份当前完整的 state。**数据量大**，主要用于状态可视化。

### `updates`：增量更新

```typescript
for await (const update of agent.stream(input, { streamMode: "updates" })) {
  // update 是 { 节点名: 该节点输出的增量 } 的形式
  // 例如 { model: { messages: [新 AI 消息] } }
  console.log(JSON.stringify(update, null, 2));
}
```

最常用于审计日志和节点级监控。能清晰看到"模型刚说了啥"、"工具刚返回了啥"。

### `messages`：token 级流

```typescript
for await (const [chunk, metadata] of agent.stream(input, {
  streamMode: "messages",
})) {
  // chunk 是 AIMessageChunk
  // metadata 含节点名、tags 等
  if (metadata.langgraph_node === "model") {
    process.stdout.write(chunk.contentBlocks?.[0]?.text ?? "");
  }
}
```

这是做"ChatGPT 实时打字"效果的官方方式。每个 chunk 是模型的部分 token，按节点过滤后写到 stdout 或 SSE 通道。

### `custom`：业务级埋点

在 tool 或 middleware 里手动发事件：

```typescript
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";

const mySlowTool = tool(
  async ({ url }) => {
    await dispatchCustomEvent("download_started", { url });
    const data = await downloadFile(url);
    await dispatchCustomEvent("download_finished", { url, size: data.length });
    return `Downloaded ${data.length} bytes`;
  },
  { name: "download", description: "...", schema: /* ... */ }
);

// 消费端：
for await (const event of agent.stream(input, { streamMode: "custom" })) {
  console.log("custom event:", event);
}
```

适合给前端推业务进度，比如"正在下载…"/"已下载 80%"。

## 直接产出 SSE（Server-Sent Events）

把 LangGraph 的事件流包成 HTTP SSE 是常见需求。`stream()` 直接支持：

```typescript
const sseStream = await agent.stream(input, {
  streamMode: "messages",
  encoding: "text/event-stream",
});

// sseStream 是 ReadableStream<Uint8Array>，每个 chunk 已经是 SSE 格式
//   data: {"event":"on_chat_model_stream","data":{...}}\n\n
```

在 Hono / Express / Next.js Route Handler 里直接当作 response body 返回：

```typescript
// Hono 示例
import { Hono } from "hono";

const app = new Hono();

app.post("/chat", async (c) => {
  const { message } = await c.req.json();
  const sseStream = await agent.stream(
    { messages: [{ role: "user", content: message }] },
    { streamMode: "messages", encoding: "text/event-stream" }
  );
  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
```

前端用 `EventSource` 或 `fetch` + `ReadableStream` 消费。完整的生产部署细节在 [流式接口 SSE / WebSocket](../08-production/streaming-api.md)。

## `streamEvents` 详解

`streamEvents` 比 `stream` 更细：拿到的不是节点级数据，而是**事件级**（每个组件的开始 / 流式 chunk / 结束）。

```typescript
for await (const event of agent.streamEvents(input, { version: "v2" })) {
  // event = { event, name, data, run_id, parent_ids, tags, metadata }
  switch (event.event) {
    case "on_chat_model_start":
      console.log(`模型 ${event.name} 开始调用`);
      break;
    case "on_chat_model_stream":
      // event.data.chunk 是 AIMessageChunk
      process.stdout.write(event.data.chunk.contentBlocks?.[0]?.text ?? "");
      break;
    case "on_chat_model_end":
      console.log(`\n模型调用结束，total tokens:`, event.data.output.usage_metadata);
      break;
    case "on_tool_start":
      console.log(`工具 ${event.name} 被调用，参数:`, event.data.input);
      break;
    case "on_tool_end":
      console.log(`工具 ${event.name} 返回:`, event.data.output);
      break;
  }
}
```

`streamEvents` 事件类型完整列表（v2）：

```
on_chat_model_start / on_chat_model_stream / on_chat_model_end
on_llm_start / on_llm_stream / on_llm_end
on_chain_start / on_chain_stream / on_chain_end
on_tool_start / on_tool_end
on_retriever_start / on_retriever_end
on_prompt_start / on_prompt_end
on_custom_event
```

## `stream` vs `streamEvents` 怎么选

| 维度 | `stream` | `streamEvents` |
|------|----------|----------------|
| 数据粒度 | 节点级（粗） | 组件级（细） |
| 事件流量 | 中（每节点 1-N 条） | 大（每组件 3+ 条）  |
| 上手难度 | 低 | 高（事件类型多） |
| 适用场景 | 聊天 UI、节点监控、SSE | 深度调试、复杂前端可视化 |
| 性能 | 好 | 一般（事件多） |

**原则**：先用 `stream`，遇到 `stream` 拿不到的东西再上 `streamEvents`。生产环境的聊天 UI **99% 用 `stream({ streamMode: "messages" })`** 就够了。

## 几个常见陷阱

### 1. messages 模式拿不到某些事件

`messages` 模式只推**模型节点**的 token chunk。如果你想看工具执行进度，需要：

- 加 `streamMode: ["messages", "updates"]`，从 `updates` 里看工具结果
- 或者在 tool 里 `dispatchCustomEvent`，用 `custom` mode 拿

### 2. token chunk 里的 `contentBlocks`

1.x 用 `contentBlocks` 取代旧的 `content`（多模态统一）。聊天 UI 里要这样取文本：

```typescript
// 正确（1.x 多模态统一）
const text = chunk.contentBlocks
  ?.filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("") ?? "";

// 老式写法（仅纯文本场景，1.x 仍可用但不推荐）
const text = typeof chunk.content === "string" ? chunk.content : "";
```

如果用户上传图片、Claude 用 thinking blocks，`contentBlocks` 是唯一安全的读法。

### 3. SSE 反向代理 buffering

如果用 Nginx / Cloudflare 在前面，必须关掉 buffering：

```
# Nginx
proxy_buffering off;
proxy_cache off;

# Cloudflare：用 Workers 直接转发，不要走 page rules 的缓存
```

否则会出现"全部 token 攒到一起，几秒后一次性吐出来"。

### 4. 客户端断开后清理

```typescript
const abortController = new AbortController();

req.on("close", () => abortController.abort());

const stream = await agent.stream(input, {
  streamMode: "messages",
  signal: abortController.signal,
});
```

不传 `signal` 的话，客户端断开后 Agent 仍然会跑完整个循环，浪费 token。

## 把这一切组合：一个生产级流式接口

```typescript
// app.ts (Hono)
import { Hono } from "hono";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

const app = new Hono();

app.post("/chat/stream", async (c) => {
  const { messages, thread_id } = await c.req.json();
  const abortController = new AbortController();

  c.req.raw.signal.addEventListener("abort", () => abortController.abort());

  const stream = await agent.stream(
    { messages },
    {
      streamMode: "messages",
      encoding: "text/event-stream",
      configurable: { thread_id },
      signal: abortController.signal,
    }
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no", // Nginx 禁 buffering
    },
  });
});

export default app;
```

前端用标准 `EventSource`：

```typescript
const es = new EventSource("/chat/stream", { method: "POST", body: JSON.stringify({...}) });
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.event === "on_chat_model_stream") {
    appendToUI(event.data.chunk.contentBlocks?.[0]?.text ?? "");
  }
};
```

完整的部署细节（包括 WebSocket 备选方案、负载均衡时的 sticky session 配置）在 [流式接口 SSE / WebSocket](../08-production/streaming-api.md)。

## 小结

LangGraph 的流式 API 分两层：`stream()` 用 5 种 mode 推节点级或 token 级数据，`streamEvents()` 推组件级事件。聊天 UI 默认用 `stream({ streamMode: "messages", encoding: "text/event-stream" })`，调试用 `streamMode: "updates"`，业务埋点用 `dispatchCustomEvent + streamMode: "custom"`。

模块 05 就此结束。下一步是 [模块 06：RAG](../06-rag/rag-pipeline.md)，把外部知识库接入 Agent。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
