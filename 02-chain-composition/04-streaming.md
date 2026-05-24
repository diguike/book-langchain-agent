---
title: Streaming 流式输出
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/DnIJwfrhRiYo10koT9kc5aTCnAd"
last_synced: "2026-05-25T02:41:10+08:00"
---

> 模块 02 - Chain 组合 | 前置知识：[RunnableSequence](./01-runnable-sequence.md)

## 流式不是体验优化，是产品级硬性要求

我做客服 Agent 时实测过：一次完整回答模型要吐 1500 个 token，端到端 6 秒钟。用户面对一个转圈圈 6 秒钟的输入框，30% 的人会直接关掉页面。改成流式之后，首 token 200ms 出现，用户感知"系统在响应"，留存率上去了。

LangChain.js 1.x 在所有 `Runnable` 上提供两套流式 API：

- **`.stream()`**：拿到最终输出的逐 chunk 流，最常用
- **`.streamEvents({ version: "v2" })`**：拿到链中**每个节点**的事件（model 开始、tool 调用、子链结束……），适合复杂 UI 和调试

这一节先把这两个 API 讲透，再点一下 SSE (Server-Sent Events) / WebSocket 的集成思路。完整的服务端实现细节放在 [08-生产部署 / 02-streaming-api.md](../08-production/02-streaming-api.md)。

## `.stream()`：最常用的流

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

const model = new ChatOpenAI({ model: "gpt-4o" });
const parser = new StringOutputParser();
const chain = model.pipe(parser);

const stream = await chain.stream("用 100 字介绍量子计算");

for await (const chunk of stream) {
  process.stdout.write(chunk); // 逐 token 输出
}
console.log();
```

`stream()` 返回 `AsyncIterableIterator<O>`，`O` 是链最后一步的输出类型。chunk 的具体类型按链的末端决定：

| 末端节点 | chunk 类型 |
|----------|-----------|
| `ChatModel` | `AIMessageChunk`（含 `contentBlocks` / `tool_call_chunks`） |
| `StringOutputParser` | `string` |
| 结构化输出（`withStructuredOutput`） | 完整对象，不真流式 |
| `RunnableLambda`（默认）| 一次性的函数返回值 |

## 哪些节点会阻断流

这是流式最关键的一条规则：**链里只有最末端能真正流式，前面任何"必须等完整输入才能工作"的节点都会把流截掉**。

LangChain.js 1.x 的真实表现：

- **可流式**：`ChatModel` / `StringOutputParser` / `RunnablePassthrough` —— 上游 chunk 进来直接往下游推
- **阻断流**：
  - 结构化输出（要等完整 JSON 才能 parse）
  - 普通 `RunnableLambda`（函数签名 `(input) => output`，必须等完整 input）
  - 工具调用（要等完整参数才能执行）

```typescript
// [ok] 全链流式
const streamable = prompt.pipe(model).pipe(new StringOutputParser());

// [bad] parser 处阻断
const blocked1 = prompt
  .pipe(model)
  .pipe(model.withStructuredOutput(schema, { strategy: "tool" }));

// [bad] lambda 处阻断（普通函数等完整输入）
const blocked2 = prompt
  .pipe(model)
  .pipe(new StringOutputParser())
  .pipe((text: string) => text.toUpperCase());
```

### 让 lambda 保持流式：用 `transform`

`RunnableLambda` 的构造器接受第二个字段 `transform`，签名是 `(chunks: AsyncIterable<I>) => AsyncIterable<O>`。提供了 `transform`，链就能继续保持流式：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const upper = new RunnableLambda<string, string>({
  // 非流式兜底
  func: (input) => input.toUpperCase(),
  // 流式实现：来一段处理一段
  transform: async function* (chunks) {
    for await (const chunk of chunks) {
      yield chunk.toUpperCase();
    }
  },
});

const chain = prompt
  .pipe(model)
  .pipe(new StringOutputParser())
  .pipe(upper); // 现在全链流式
```

## `.streamEvents()`：拿到链里的每一个事件

`.streamEvents({ version: "v2" })` 比 `.stream()` 更细粒度。它推送链中每个节点的开始、流、结束事件，能让你在 UI 里实时显示"正在思考"、"正在调工具 search_web"、"正在生成回答"这种状态。

```typescript
const chain = prompt.pipe(model).pipe(new StringOutputParser());

const eventStream = chain.streamEvents(
  { concept: "量子纠缠" },
  { version: "v2" }, // v2 是当前稳定版本，必填
);

for await (const event of eventStream) {
  switch (event.event) {
    case "on_chat_model_stream": {
      // 模型吐出的每个 token
      const chunk = event.data.chunk; // AIMessageChunk
      // 1.x 推荐用 contentBlocks 拿统一格式的内容
      const text = chunk.contentBlocks
        ?.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("") ?? "";
      process.stdout.write(text);
      break;
    }
    case "on_chain_start":
      console.log(`\n[chain start] ${event.name}`);
      break;
    case "on_chain_end":
      console.log(`\n[chain end]   ${event.name}`);
      break;
  }
}
```

### 常用事件类型

| 事件 | 触发时机 | data 内容 |
|------|---------|----------|
| `on_chain_start` | 链 / 子链开始 | `input` |
| `on_chain_stream` | 链产出一个 chunk | `chunk` |
| `on_chain_end` | 链 / 子链完成 | `output` |
| `on_chat_model_start` | Chat 模型调用开始 | 输入消息列表 |
| `on_chat_model_stream` | Chat 模型产出一个 chunk | `AIMessageChunk` |
| `on_chat_model_end` | Chat 模型完成 | 完整 `AIMessage` |
| `on_tool_start` | 工具调用开始 | tool input |
| `on_tool_end` | 工具调用完成 | tool output |

注意：1.x 推荐用 `on_chat_model_*` 系列处理 Chat 模型事件。

### 过滤事件

复杂链里事件量非常大，必须过滤。`streamEvents` 支持三种过滤参数：

```typescript
const eventStream = chain.streamEvents(input, {
  version: "v2",
  // 只听这些 name 的节点
  includeNames: ["MainModel"],
  // 或者按 tag 过滤
  includeTags: ["important"],
  // 或者按类型过滤
  includeTypes: ["chat_model"],
});
```

给节点打 tag 和 name：

```typescript
const taggedModel = model.withConfig({
  tags: ["important"],
  runName: "MainModel",
});
```

## 模型层的 `contentBlocks`

LangChain.js 1.x 把消息内容统一成 `contentBlocks`——一个 ContentBlock 数组，每个 block 有 `type` 字段标识是文本、工具调用、图片还是别的。流式时这点很重要：

```typescript
for await (const chunk of model.stream("你好")) {
  // chunk 是 AIMessageChunk
  for (const block of chunk.contentBlocks ?? []) {
    if (block.type === "text") {
      process.stdout.write(block.text);
    } else if (block.type === "tool_use") {
      console.log("[模型在请求工具]", block.name);
    }
  }
}
```

`chunk.content` 在 1.x 里仍然存在，但是各 provider 的格式不统一，视为 deprecated，新代码请用 `chunk.text` 或 `chunk.contentBlocks`。

## SSE / WebSocket 集成思路

把 LangChain.js 的流接到 HTTP 层，业界两种主流方案：

- **SSE (Server-Sent Events)**：基于 HTTP 长连接，浏览器原生支持 `EventSource`，单向（服务端 → 客户端）。适合聊天、流式回答这种"服务端推、客户端只接收"的场景。
- **WebSocket**：双向通信，适合需要客户端实时反向控制（暂停、修改、HITL 介入）的场景。

90% 的 LLM 聊天 UI 用 SSE 就够了。最小骨架长这样：

```typescript
// minimal-sse-handler.ts
import type { Request, Response } from "express";

export async function handleStream(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Nginx / 反向代理不要缓冲

  // 客户端断开就取消上游
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    const stream = await chain.stream(req.body, { signal: ac.signal });

    for await (const chunk of stream) {
      // SSE 格式：data: <一行 JSON>\n\n
      res.write(`data: ${JSON.stringify({ type: "token", content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`,
    );
  } finally {
    res.end();
  }
}
```

客户端（浏览器）只用一行 `new EventSource(url)` 就能接，或者用 `fetch` + ReadableStream 自己拆 chunk。

**完整的生产实现**——心跳保活、断线重连、错误恢复、token 计数、防 buffer 卡顿、Nginx 配置、跨域、鉴权——都在 [08-生产部署 / 02-streaming-api.md](../08-production/02-streaming-api.md) 里展开，这里只点到为止。

## AbortController：让用户取消

用户在浏览器上点了"停止生成"按钮、或者切到了别的话题，应该立刻取消上游 LLM 调用，省 token 也省时间。`.stream()` 和 `.invoke()` 都接受 `signal` 参数：

```typescript
const controller = new AbortController();

// UI 上：点击取消按钮触发
cancelButton.onclick = () => controller.abort();

try {
  const stream = await chain.stream(
    { question: "写一篇长文..." },
    { signal: controller.signal },
  );

  for await (const chunk of stream) {
    display(chunk);
  }
} catch (err) {
  if ((err as Error).name === "AbortError") {
    console.log("用户取消了生成");
  } else {
    throw err;
  }
}
```

服务端也得监听客户端断连：HTTP 连接关闭时 `req.on('close')` 会触发，这时候 abort 上游的 controller 就行。上面 SSE 骨架里已经写了。

## 流式 + 错误处理

流式跟 `invoke` 模式有个本质差别——一旦开始推数据，部分内容已经发给客户端了，再出错时不能像 `invoke` 那样直接 throw。我的处理模式：

```typescript
res.setHeader("Content-Type", "text/event-stream");

try {
  let tokenCount = 0;
  const stream = await chain.stream(input, { signal: ac.signal });

  for await (const chunk of stream) {
    tokenCount++;
    res.write(`data: ${JSON.stringify({ type: "token", content: chunk })}\n\n`);

    // 安全阀：单次响应硬上限
    if (tokenCount > 4096) {
      res.write(`data: ${JSON.stringify({ type: "warning", message: "输出已达上限" })}\n\n`);
      ac.abort();
      break;
    }
  }
} catch (err) {
  // 已发的内容客户端先显示，错误作为额外事件推过去
  res.write(`data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`);
} finally {
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  res.end();
}
```

客户端拿到 `type: "error"` 时可以在 UI 上展示"生成中断"提示，已经流出来的内容保留不动。比"整段消失"对用户友好得多。

## 小结

| 项 | 说明 |
|----|------|
| `.stream()` | 拿最终输出的逐 chunk 流，最常用 |
| `.streamEvents({ version: "v2" })` | 拿链中每个节点的事件，适合复杂 UI / 调试 |
| 全链流式 | ChatModel + StringOutputParser + Passthrough |
| 阻断流的节点 | 结构化输出、普通 lambda、工具调用 |
| 自定义流式 | 给 `RunnableLambda` 加 `transform` |
| 模型 chunk | 用 `chunk.contentBlocks` 拿统一格式 |
| HTTP 集成 | SSE 是默认选择，WebSocket 用于双向场景；详见 08-生产部署 |
| 取消 | `AbortController` + `signal`，客户端断连自动 abort |

下一节我讲 [Fallback 与重试](./05-fallback-retry.md)——LLM API 偶发失败时怎么保证链的可用性。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
