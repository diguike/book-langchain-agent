---
title: LangGraph State 与 Checkpointer
feishu_url: ""
last_synced: ""
---

> 模块 05 - Agent 架构 | 前置知识：[LangGraph 入门](./langgraph-intro.md)

## State 是 Agent 的工作记忆

[LangGraph 入门](./langgraph-intro.md) 里我把 state 一笔带过：`Annotation.Root` 描述字段、reducer 决定合并语义。这一节展开两件事——

1. **State 设计**：哪些字段需要存、哪些字段配什么 reducer、踩过的坑
2. **Checkpointer**：把 state 持久化到 SQLite / Postgres，实现断点续跑、多用户会话隔离、时间旅行

我把这两件事放在一起讲，因为它们是同一件事的两面：state 是 "在某一刻 Agent 知道什么"，checkpointer 是 "把这份 know-what 跨进程持续下来"。

## State 设计四条原则

### 1. 最小化

只放节点之间需要共享的数据。**完整 LLM 响应对象、整个 PDF 文本、数据库连接**都不该进 state。

```typescript
// 反例：把完整 PDF 内容塞进 state
const BadState = Annotation.Root({
  document: Annotation<string>, // 50MB PDF 转的字符串
  messages: Annotation<BaseMessage[]>({ ... }),
});

// 正例：state 里只放引用
const GoodState = Annotation.Root({
  documentId: Annotation<string>, // 指向外部存储的 ID
  messages: Annotation<BaseMessage[]>({ ... }),
});
```

state 越大，每个 checkpoint 越大，序列化越慢，多实例同步越贵。

### 2. 可序列化

Checkpointer 会把 state 写到磁盘或数据库。**函数引用、Date 对象、Map / Set、Symbol** 都序列化不了。用 plain object、数组、字符串、数字、布尔值。

如果非要存复杂对象，自己实现 toJSON / fromJSON：

```typescript
const SomeState = Annotation.Root({
  // ISO 字符串，而非 Date
  createdAt: Annotation<string>,
  // 数组，而非 Set
  visitedUrls: Annotation<string[]>({
    reducer: (cur, upd) => [...new Set([...cur, ...upd])],
    default: () => [],
  }),
});
```

### 3. 明确语义

每个字段配不配 reducer、配什么 reducer，必须想清楚：

| 字段类型 | reducer 选择 | 示例 |
|----------|--------------|------|
| 消息历史 | 追加（用 `messagesStateReducer`） | `MessagesAnnotation` |
| 当前任务描述 | 不配（覆盖） | `currentStep` |
| 累积结果集 | 合并去重 | `searchResults` |
| 步骤计数器 | 累加 | `iteration` |
| 最终答案 | 不配（覆盖） | `response` |
| 累计 token 消耗 | 累加 | `tokensUsed` |

**有疑问时倾向于"不配 reducer"**——覆盖语义更简单，出问题更容易调试。需要累积时再加 reducer。

### 4. 类型安全

`Annotation<T>` 的泛型别留空。`any` / `unknown` 在节点函数里会让 IDE 提示全废。

```typescript
// 烂
const BadState = Annotation.Root({
  data: Annotation<any>,
});

// 好
type Order = { id: string; total: number; items: string[] };
const GoodState = Annotation.Root({
  data: Annotation<Order | null>({
    reducer: (_, upd) => upd,
    default: () => null,
  }),
});
```

## Reducer 详解

Reducer 是个 `(current, update) => newValue` 函数，决定一个字段被并发节点同时更新时怎么合并。最常见的几种模式：

### 追加

```typescript
messages: Annotation<BaseMessage[]>({
  reducer: (current, update) => [...current, ...update],
  default: () => [],
}),
```

### 累加

```typescript
tokensUsed: Annotation<number>({
  reducer: (current, update) => current + update,
  default: () => 0,
}),
```

### 合并去重

```typescript
visitedUrls: Annotation<string[]>({
  reducer: (current, update) => [...new Set([...current, ...update])],
  default: () => [],
}),
```

### 整体替换（显式声明）

```typescript
plan: Annotation<string[]>({
  reducer: (_, update) => update,
  default: () => [],
}),
```

写 `reducer: (_, update) => update` 等价于"不配 reducer"，但显式声明可读性更好。

### 并发合并

```typescript
results: Annotation<Record<string, unknown>>({
  reducer: (current, update) => ({ ...current, ...update }),
  default: () => ({}),
}),
```

并发节点 A、B 同时返回 `{ results: { a: 1 } }` 和 `{ results: { b: 2 } }`，最终 state 里是 `{ a: 1, b: 2 }`。

## MessagesAnnotation 的智能合并

`MessagesAnnotation` 自带的 `messagesStateReducer` 有三个特殊行为：

```typescript
import { MessagesAnnotation, type RemoveMessage } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// 1. 没 ID 的新消息 → 追加
state.messages = [new HumanMessage("hi")];
// 节点返回 { messages: [new AIMessage("hello")] }
// → state.messages = [HumanMessage("hi"), AIMessage("hello")]

// 2. 有 ID 且 ID 匹配 → 替换（流式更新场景必备）
state.messages = [new AIMessage({ id: "msg-1", content: "Hel" })];
// 节点返回 { messages: [new AIMessage({ id: "msg-1", content: "Hello" })] }
// → state.messages = [AIMessage({ id: "msg-1", content: "Hello" })]  ← 替换

// 3. RemoveMessage → 删除
import { RemoveMessage } from "@langchain/langgraph";
// 节点返回 { messages: [new RemoveMessage({ id: "msg-1" })] }
// → 从列表里移除 id 为 msg-1 的消息
```

第三个行为用来做"上下文窗口管理"——长会话里把早期消息删掉：

```typescript
import { RemoveMessage } from "@langchain/langgraph";

async function trimContextNode(state: typeof MessagesAnnotation.State) {
  // 保留最近 20 条
  if (state.messages.length <= 20) return {};
  const toRemove = state.messages
    .filter((m) => m.getType() !== "system")
    .slice(0, state.messages.length - 20);
  return {
    messages: toRemove.map((m) => new RemoveMessage({ id: m.id! })),
  };
}
```

注意 `m.getType()` 是 1.x 的写法，0.3 的 `_getType()` 已 deprecated。

## Checkpointer：让 state 跨进程

State 设计完了，下一个问题是：**进程崩了、用户关了浏览器、明天再来对话，怎么续上？** 答案是 Checkpointer——每个节点跑完自动写一份 state 快照到存储。

### MemorySaver：开发用

```typescript
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();
const app = graph.compile({ checkpointer });

// 用 thread_id 标识一个会话
const cfg = { configurable: { thread_id: "user-001-session-1" } };

await app.invoke({ messages: [{ role: "user", content: "我叫张三" }] }, cfg);
await app.invoke({ messages: [{ role: "user", content: "我叫什么？" }] }, cfg);
// → 第二轮能记住"张三"，因为 checkpointer 把第一轮的 messages 存了下来
```

`MemorySaver` 把状态放进程内存，重启丢失。**只用来开发和测试，绝不上生产**。

### SqliteSaver：单机生产

单实例部署用 SQLite 就够了：

```bash
npm install @langchain/langgraph-checkpoint-sqlite
```

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// 文件数据库
const checkpointer = SqliteSaver.fromConnString("./agent.db");

// 或者内存数据库（测试）
const memDb = SqliteSaver.fromConnString(":memory:");

const app = graph.compile({ checkpointer });
```

第一次跑会自动建表。SQLite 适合单机部署的小工具、Electron 桌面应用、原型验证。

### PostgresSaver：多实例生产

要多实例水平扩展、要并发安全、要事务保证，上 Postgres：

```bash
npm install @langchain/langgraph-checkpoint-postgres
```

```typescript
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(
  "postgresql://user:pass@localhost:5432/agent_db"
);

// 第一次部署需要建表
await checkpointer.setup();

const app = graph.compile({ checkpointer });
```

部署到 K8s 多副本、Vercel Edge、Cloud Run 这类无状态计算环境时必须用 PostgresSaver——每个实例都连同一个 Postgres，请求落到哪个实例都能读到同一份 state。

### 三选一的判断

| Checkpointer | 持久化 | 多进程安全 | 适用场景 |
|--------------|--------|------------|----------|
| MemorySaver | 否 | 否 | 开发、单元测试、Notebook |
| SqliteSaver | 是 | 否（文件锁不可靠） | 单机部署、桌面工具 |
| PostgresSaver | 是 | 是 | 生产、多实例、SaaS |

## thread_id：多用户隔离

Checkpointer 用 `thread_id` 区分"哪条会话"。同一个 `thread_id` 的多次调用共享同一份 state；不同 `thread_id` 完全隔离。

```typescript
const aliceCfg = { configurable: { thread_id: "user-alice" } };
const bobCfg = { configurable: { thread_id: "user-bob" } };

await app.invoke({ messages: [{ role: "user", content: "我叫 Alice" }] }, aliceCfg);
await app.invoke({ messages: [{ role: "user", content: "我叫 Bob" }] }, bobCfg);

// Alice 的会话里只看得到自己的消息，看不到 Bob 的
const aliceState = await app.getState(aliceCfg);
console.log(aliceState.values.messages); // 只有 Alice 那条
```

**生产实践**：`thread_id` 用 `{userId}-{sessionId}` 组合。`userId` 隔离用户，`sessionId` 让同一用户开多个独立对话（如 ChatGPT 的"新对话"按钮）。

## 查看与回溯状态

Checkpointer 不光存"最新 state"，它存的是**每一步的快照**。这开启了三个能力：

### `getState`：当前 state

```typescript
const snapshot = await app.getState(cfg);
console.log(snapshot.values); // 当前完整 state
console.log(snapshot.next); // 下一个待执行节点（如果 graph 被 interrupt 暂停了）
console.log(snapshot.config.configurable?.checkpoint_id); // 当前 checkpoint ID
```

### `getStateHistory`：所有历史快照

```typescript
const history = app.getStateHistory(cfg);
for await (const snap of history) {
  console.log(
    snap.config.configurable?.checkpoint_id,
    "messages:",
    snap.values.messages.length,
    "createdAt:",
    snap.createdAt
  );
}
```

### Time travel：从某个 checkpoint 重新跑

调试或者"撤销"操作时极有用——指定一个旧的 `checkpoint_id`，从那一刻继续：

```typescript
// 拿到某个历史快照
const allSnapshots: any[] = [];
for await (const s of app.getStateHistory(cfg)) allSnapshots.push(s);
const targetCheckpointId = allSnapshots[3].config.configurable!.checkpoint_id;

// 从那一刻接着跑，传新的输入
const result = await app.invoke(
  { messages: [{ role: "user", content: "假设那一步选了 B" }] },
  {
    configurable: {
      thread_id: "user-alice",
      checkpoint_id: targetCheckpointId, // ← 关键
    },
  }
);
```

这是 [Human-in-the-Loop](./human-in-the-loop.md) 实现"修改后恢复"的底层机制。

## 完整示例：带持久化的会话型 Agent

把所有概念串起来——一个能记住用户名、跨会话保持状态的 Agent：

```typescript
// stateful-agent.ts
import {
  StateGraph,
  START,
  END,
  Annotation,
  MessagesAnnotation,
  MemorySaver,
} from "@langchain/langgraph";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AIMessage } from "@langchain/core/messages";

// 1. 扩展 MessagesAnnotation
const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  userName: Annotation<string>({
    reducer: (_, upd) => upd,
    default: () => "",
  }),
  toolBudget: Annotation<number>({
    reducer: (cur, upd) => cur - upd,
    default: () => 10, // 每会话最多 10 次工具调用
  }),
});

// 2. 工具
const rememberName = tool(
  async ({ name }) => `已记住用户名：${name}`,
  {
    name: "remember_name",
    description: "记住用户告诉你的名字",
    schema: z.object({ name: z.string() }),
  }
);

// 3. 内部 Agent —— createAgent 自带 model ↔ tools 循环
const innerAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [rememberName],
});

// Agent 节点：动态注入 systemPrompt（依赖 state.userName），调内层 agent
async function agentNode(state: typeof AgentState.State) {
  const sys = state.userName
    ? `你是个人助手，当前用户叫 ${state.userName}。`
    : "你是个人助手。如果用户告诉你名字，调用 remember_name 工具记下来。";

  const result = await innerAgent.invoke({
    messages: [{ role: "system", content: sys }, ...state.messages],
  });

  // 只把内层 agent 新产生的消息追加回主 state
  const newMessages = result.messages.slice(state.messages.length + 1);
  return { messages: newMessages };
}

// 4. 后处理 —— 从最近一批 ai 消息的 tool_calls 提取 name，更新外层 state
async function syncUserName(state: typeof AgentState.State) {
  const update: Partial<typeof AgentState.State> = {};
  for (const m of state.messages) {
    if (m.getType() !== "ai") continue;
    const ai = m as AIMessage;
    for (const tc of ai.tool_calls ?? []) {
      if (tc.name === "remember_name" && tc.args.name) {
        update.userName = tc.args.name as string;
        update.toolBudget = 1; // 减 1（reducer 是累减）
      }
    }
  }
  return update;
}

// 5. 组图
const graph = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("sync", syncUserName)
  .addEdge(START, "agent")
  .addEdge("agent", "sync")
  .addEdge("sync", END);

const checkpointer = new MemorySaver(); // 生产换 PostgresSaver
const app = graph.compile({ checkpointer });

// 7. 多轮对话演示
const cfg = { configurable: { thread_id: "demo-thread-1" } };

console.log("--- 第一轮 ---");
const r1 = await app.invoke(
  { messages: [{ role: "user", content: "你好，我叫李明" }] },
  cfg
);
console.log("回复:", r1.messages.at(-1)?.content);
console.log("userName:", r1.userName);

console.log("\n--- 第二轮（同一 thread_id，应该记住名字）---");
const r2 = await app.invoke(
  { messages: [{ role: "user", content: "我叫什么名字？" }] },
  cfg
);
console.log("回复:", r2.messages.at(-1)?.content);

console.log("\n--- 状态历史 ---");
let count = 0;
for await (const snap of app.getStateHistory(cfg)) {
  console.log(
    `快照 ${++count}: messages=${snap.values.messages.length}, userName=${snap.values.userName}, budget=${snap.values.toolBudget}`
  );
  if (count >= 5) break;
}
```

观察输出，能看到 state 在 thread 内累积，而切换 `thread_id` 完全隔离。

## 几个生产坑

### Checkpointer 不要忘了 setup

`PostgresSaver` 第一次用必须 `await checkpointer.setup()` 建表。CI 跑测试时也要建。

### thread_id 不要写死

代码里 hard-code 一个 `"thread-1"` 一次能跑通，多用户上线就炸——所有人共享同一份 state。生产必须从请求里取 userId / sessionId 拼出来。

### state 大小要监控

每个 checkpoint 都包含完整 state 快照。如果 `messages` 字段无限增长，单个 checkpoint 几 MB，几千个用户就压垮 Postgres。要么定期 trim messages，要么把大字段（如完整文档）移到对象存储，state 里只放 ID。

### Time travel 别用错

`checkpoint_id` 走的是 graph 那时刻的快照。如果你的 graph 拓扑改了（加了节点、改了 state schema），从老 checkpoint 恢复可能行为奇怪。**版本灰度发布 graph 时，要么不允许从旧 checkpoint 恢复，要么写迁移逻辑**。

## 小结

State 是 LangGraph 的工作记忆。用 `Annotation.Root` 定义字段，每个字段可选配 reducer 决定合并语义（追加、累加、合并、覆盖）。`MessagesAnnotation` 是消息状态的预制件，自带智能追加/替换/删除行为。

Checkpointer 把 state 持久化——开发用 `MemorySaver`，单机生产用 `SqliteSaver`，多实例生产用 `PostgresSaver`。用 `thread_id` 隔离多用户、多会话。每次节点跑完自动写快照，开启了 `getState` / `getStateHistory` / Time travel 三种能力。

下一节 [Plan and Execute](./plan-and-execute.md) 用 LangGraph 实现一种"先规划再执行"的 Agent 架构；之后是 [Self-Reflection](./self-reflection.md) 的双 Agent 循环。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
