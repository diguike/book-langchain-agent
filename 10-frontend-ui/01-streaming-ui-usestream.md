---
title: 生成式 UI 与 useStream
feishu_url: ""
last_synced: ""
---

> 模块 10 - 前端集成 | 前置知识：[LangGraph Platform 部署](../08-production/06-langgraph-platform.md)、[流式输出深入 Stream Modes](../05-agent-architecture/10-stream-modes.md)

## Agent 的前端比你想的麻烦

后端 Agent 跑通只是一半。要做成产品，前端得把这些都呈现出来：token 一个个冒出来的打字机效果、Agent 正在调哪个工具、工具返回了什么、遇到高风险操作弹出审批框、刷新页面还能接着上次的会话聊。

自己撸这套前端很费劲——要手动接 SSE、解析事件流、维护消息列表的增量拼接、处理中断恢复、管 thread 状态。我第一次做的时候，光"token 流式拼接 + 中途能停"就调了一下午。

LangChain 给前端准备了一个 React hook `useStream`，把上面这些全包了。你写的还是普通 React 组件，但 token 流、工具调用、HITL 中断、会话续接都由它接管。这一节用它对接上一节部署好的 [LangGraph Server](../08-production/06-langgraph-platform.md)，做一个能用的聊天界面。

## 先认准是哪个 useStream

开始前先排一个雷：npm 上有**两个**叫 `useStream` 的东西，接口不一样。

- **`@langchain/langgraph-sdk/react`** —— 官方文档采用的稳定入口，本章和绝大多数教程用的就是它。
- `@langchain/react` —— 另一个独立包，也导出 `useStream`，但 options 和返回结构是另一套（带 `switchThread`、`subagents` 等）。

两者别混着写，否则字段对不上。本章统一用前者：

```tsx
import { useStream } from "@langchain/langgraph-sdk/react";
```

## 三十行一个流式聊天界面

假设你已经用 `langgraphjs dev` 把 agent 跑在了 `http://localhost:2024`，`langgraph.json` 里 graph 的 key 是 `"agent"`。前端组件：

```tsx
// Chat.tsx
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";
import { useState } from "react";

export default function Chat() {
  const [input, setInput] = useState("");

  const thread = useStream<{ messages: Message[] }>({
    apiUrl: "http://localhost:2024",
    assistantId: "agent", // langgraph.json 里 graphs 的 key
    messagesKey: "messages",
    onThreadId: (id) => {
      // 新会话创建时把 thread id 写进 URL，刷新后可续聊
      window.history.replaceState({}, "", `?threadId=${id}`);
    },
  });

  return (
    <div>
      {/* messages 里的 token 已自动拼接好 */}
      {thread.messages.map((m) => (
        <div key={m.id}>
          <b>{m.type}：</b>
          {typeof m.content === "string" ? m.content : JSON.stringify(m.content)}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          thread.submit({ messages: [{ type: "human", content: input }] });
          setInput("");
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        {thread.isLoading ? (
          <button type="button" onClick={() => thread.stop()}>
            停止
          </button>
        ) : (
          <button type="submit">发送</button>
        )}
      </form>
    </div>
  );
}
```

这就是一个完整的流式聊天界面。`thread.messages` 是已经把 token chunk 拼接好的消息数组——你不用自己接 SSE、不用自己拼 token。`thread.isLoading` 告诉你 run 是否进行中，`thread.stop()` 能中途打断。

几个常用返回值：

| 字段 | 作用 |
|------|------|
| `thread.messages` | 消息数组，token 已自动拼接 |
| `thread.values` | 当前 state 全量值 |
| `thread.isLoading` | run 是否进行中 |
| `thread.error` | 最近一次错误 |
| `thread.submit(input, opts?)` | 提交一轮输入，启动/续写 run |
| `thread.stop()` | 中断当前 run |
| `thread.interrupt` | 当前 HITL 中断值，无则 `undefined` |

注意 options 里**没有 `streamMode`**——`useStream` 内部固定用 `messages-tuple` 来累积 token，这也是为什么它能直接给你拼好的 `messages`。想换 streamMode 得退到底层 `client.runs.stream`，那是后面讲的。

## 在前端处理 HITL 审批

[Human-in-the-Loop](../05-agent-architecture/09-human-in-the-loop.md) 那一节讲了后端怎么用 `humanInTheLoopMiddleware` 在高风险工具前暂停。前端这边，`useStream` 把暂停信号放在 `thread.interrupt` 里——它一旦有值，就说明 Agent 停在等审批，你渲染一个审批 UI，用户点完用 `submit` 续写：

```tsx
{thread.interrupt && (
  <div className="approval-box">
    <p>需要确认：{JSON.stringify(thread.interrupt.value)}</p>
    <button
      onClick={() =>
        thread.submit(undefined, { command: { resume: { decisions: [{ type: "approve" }] } } })
      }
    >
      批准
    </button>
    <button
      onClick={() =>
        thread.submit(undefined, {
          command: { resume: { decisions: [{ type: "reject", message: "用户拒绝" }] } },
        })
      }
    >
      拒绝
    </button>
  </div>
)}
```

续写 HITL 的关键是 `submit` 的第一参传 `undefined`（不发新消息）、第二参传 `{ command: { resume } }`。`resume` 的结构跟后端 `humanInTheLoopMiddleware` 约定的一致——`{ decisions: [{ type: "approve" | "edit" | "reject" }] }`。前端只管把审批结果用这个形状传回去，Server 自动从暂停点继续跑。

## 会话续接：刷新不丢上下文

`onThreadId` 回调在新会话创建时给你 thread id，上面例子把它写进了 URL。下次进来从 URL 读出来传 `threadId`，`useStream` 会自动拉回这个会话的历史：

```tsx
const threadId = new URLSearchParams(window.location.search).get("threadId");

const thread = useStream<{ messages: Message[] }>({
  apiUrl: "http://localhost:2024",
  assistantId: "agent",
  threadId, // 传入已有 thread，自动加载历史
  onThreadId: (id) => {
    window.history.replaceState({}, "", `?threadId=${id}`);
  },
});
```

历史持久化是 Server 那边 checkpointer 做的事（见 [State 与 Checkpointer](../05-agent-architecture/04-langgraph-state.md)），前端只需要把 `threadId` 带上。用户隔天回来、换设备登录，凭这个 id 都能接着聊。

## 不用 React 怎么办

`useStream` 是 React 专属。其他框架（Vue、Svelte，或纯后端对后端）用底层 `Client`，它和 hook 连的是同一个 Server：

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const thread = await client.threads.create();
const stream = client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "你好" }] },
  streamMode: "messages-tuple",
});

for await (const chunk of stream) {
  // chunk.event / chunk.data —— 自己决定怎么渲染
  console.log(chunk.event, chunk.data);
}
```

`Client` 的子客户端（`threads` / `runs` / `assistants` / `store` / `crons`）和 Server 的 REST 路由一一对应（见 [LangGraph Platform 部署](../08-production/06-langgraph-platform.md)）。`useStream` 本质就是把 `client.runs.stream` 这套包装成了 React 状态。

## 小结

`useStream`（来自 `@langchain/langgraph-sdk/react`，别和 `@langchain/react` 搞混）把 Agent 前端最麻烦的几件事——token 流式拼接、工具调用呈现、HITL 中断、会话续接——封装成一个 React hook。核心用法：`submit(input)` 发消息、`thread.messages` 拿拼好的消息、`thread.isLoading` + `stop()` 控制进行中的 run、`thread.interrupt` + `submit(undefined, { command: { resume } })` 处理审批、`threadId` + `onThreadId` 做会话续接。它内部固定用 `messages-tuple`，不暴露 `streamMode`。非 React 用底层 `Client`。

至此一个 Agent 从后端 graph、到 LangGraph Server、再到流式前端的完整链路就通了。模块 10 后续章节会在这个基础上做更复杂的生成式 UI——让 Agent 不只返回文本，还能驱动前端渲染图表、表单、富交互组件。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
