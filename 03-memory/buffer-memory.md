---
title: 短期记忆 - thread-based checkpointer
feishu_url: ""
last_synced: ""
---

> 模块 03 - 记忆系统 | 第 2 节 | 前置：[1.x 时代的记忆系统](./memory-overview.md)

## 一句话定义

LangChain.js 1.x 的"短期记忆"就是：**给 `createAgent` 配一个 `checkpointer`，每次 invoke 时带上 `thread_id`，框架自动帮你存取这条 thread 的完整消息历史**。不用再自己维护 `sessionId → messages[]` 的字典。

老版本里你大概用过这种代码：

```typescript
// 上一代做法，1.x 仍能用但不推荐
const memory = new BufferMemory({ returnMessages: true });
const chain = new ConversationChain({ llm: model, memory });
```

新做法把这件事下沉到了 LangGraph 的 `checkpointer` 层。

## 第一个有记忆的 Agent

先装包：

```bash
npm install langchain @langchain/anthropic @langchain/langgraph @langchain/core
```

写一个会记住"我叫什么"的 Agent：

```typescript
// buffer-demo.ts
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  systemPrompt: "你是一个简洁的助手，会记住用户提过的信息。",
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: "demo-thread-1" } };

await agent.invoke(
  { messages: [{ role: "user", content: "我叫张三，今年 28" }] },
  config
);

const r = await agent.invoke(
  { messages: [{ role: "user", content: "我多大了？" }] },
  config
);

console.log(r.messages.at(-1)?.content);
// → "你 28 岁。"
```

跑起来：

```bash
ANTHROPIC_API_KEY=sk-ant-xxx npx tsx buffer-demo.ts
```

注意第二次 `invoke` 时，我**只传了新的一条用户消息**。Agent 自动把同一个 `thread_id` 之前的所有消息都加载回来拼到前面。这是 1.x 短期记忆的核心：**你不再管历史，框架管**。

## checkpointer 到底做了什么

每次 `agent.invoke` 跑完，LangGraph 会把这一刻的完整 state（默认就是 `messages` 数组）打包成一个 **checkpoint**，按 `thread_id` 存到 checkpointer 里。下一次同 `thread_id` 再 invoke，框架在执行前先把最新 checkpoint 读出来作为初始 state。

可以理解为每个 thread 是一棵 checkpoint 树：

```
thread "demo-thread-1"
  ├── checkpoint-1: [HumanMsg("我叫张三")]
  ├── checkpoint-2: [Human, AIMsg("你好张三")]
  ├── checkpoint-3: [..., HumanMsg("我多大了")]
  └── checkpoint-4: [..., AIMsg("你 28 岁")]
```

每个 checkpoint 都是一个不可变的状态快照。这给后面的"时间旅行"（回退到任意 checkpoint）打下基础——后续 [State、Channels 与 Checkpointer](../05-agent-architecture/langgraph-state.md) 会展开。

可以直接看 thread 当前的 state：

```typescript
const state = await agent.getState(config);
console.log("当前消息条数:", state.values.messages.length);
console.log("下一步要执行的节点:", state.next);
```

也可以遍历整个历史：

```typescript
for await (const snapshot of agent.getStateHistory(config)) {
  console.log(snapshot.config, snapshot.values.messages.length);
}
```

## 三种 checkpointer 后端

LangGraph 官方提供三种 checkpointer 实现：

| 后端 | 包 | 适用 |
|------|----|----|
| `MemorySaver` | `@langchain/langgraph` | 开发、测试、单元测试，进程一退全没 |
| `SqliteSaver` | `@langchain/langgraph-checkpoint-sqlite` | 单机部署、桌面应用、边缘场景 |
| `PostgresSaver` | `@langchain/langgraph-checkpoint-postgres` | 生产环境 |

### MemorySaver

最简单，就一行：

```typescript
import { MemorySaver } from "@langchain/langgraph";
const checkpointer = new MemorySaver();
```

进程退出，所有 thread 都消失。生产环境绝不要用。

### SqliteSaver

零运维，文件就是数据库。适合 demo、单机工具、Electron 应用：

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const checkpointer = SqliteSaver.fromConnString("./data/checkpoints.db");

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  checkpointer,
});
```

进程重启后，同样的 `thread_id` 还能续上对话。SQLite 单进程串行写入，多进程同时写会有锁竞争——如果你需要多个 Node 进程共享同一份记忆，跳到下面的 PostgresSaver。

安装：

```bash
npm install @langchain/langgraph-checkpoint-sqlite
```

### PostgresSaver

生产推荐。支持高并发、可观测、和现有 PG 基础设施复用：

```typescript
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(
  process.env.DATABASE_URL!  // postgres://user:pass@host:5432/db
);

// 首次需要建表（幂等，重复跑没事）
await checkpointer.setup();

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  checkpointer,
});
```

`setup()` 会创建 `checkpoints` / `checkpoint_writes` / `checkpoint_blobs` 等几张表。生产环境通常在应用启动时跑一次，或者放进数据库迁移脚本。

安装：

```bash
npm install @langchain/langgraph-checkpoint-postgres pg
```

### 选哪个

我的经验：

- **DEMO / 单元测试**：`MemorySaver`
- **本地工具 / 单机 SaaS**：`SqliteSaver`
- **任何需要重启不丢、需要扩容、需要观测的生产服务**：`PostgresSaver`
- **延迟极敏感、规模极大的场景**：自己实现 Redis-based checkpointer，第 5 节会讲怎么做

## 控制历史长度：beforeModel 中 trim

checkpointer 默认会无限存下去。聊到 200 轮，消息列表就太长了，模型推理慢、token 贵、还可能超 context window。

老版本里这个事靠 `BufferWindowMemory(k=10)` 解决。1.x 的对等方案是**在 middleware 的 `beforeModel` 钩子里裁剪 state.messages**：

```typescript
import { createAgent, createMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { trimMessages } from "@langchain/core/messages";

const trimmer = trimMessages({
  maxTokens: 4000,
  strategy: "last",
  tokenCounter: (msgs) => msgs.reduce((s, m) => s + (m.text?.length ?? 0) / 3, 0),
  includeSystem: true,
  startOn: "human",
});

const windowMiddleware = createMiddleware({
  name: "window",
  beforeModel: async (state) => {
    const trimmed = await trimmer.invoke(state.messages);
    return { messages: trimmed };
  },
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  middleware: [windowMiddleware],
  checkpointer: new MemorySaver(),
});
```

关键点：

- `beforeModel` 在每次调模型之前跑。返回的 `messages` 会**临时**替换 state，仅对这次模型调用生效——**完整历史仍然存在 checkpoint 里**
- 这意味着你可以用一个很小的窗口推理，但完整历史随时可以回放（比如用于审计、debug、时间旅行）
- 老版本的 `BufferWindowMemory` 是**直接丢弃**旧消息，1.x 这个写法是**遮住但不删**，更安全

`trimMessages` 的参数：

| 参数 | 说明 |
|------|------|
| `maxTokens` | token 上限 |
| `strategy` | `"last"` 留最新（最常用），`"first"` 留最早 |
| `tokenCounter` | 函数或 BaseChatModel 实例 |
| `includeSystem` | 是否始终保留 system message |
| `startOn` | `"human"` 保证窗口从用户消息开始 |
| `allowPartial` | 是否允许从中间截单条消息 |

如果你希望更激进——比如旧消息直接压缩成摘要而不只是丢弃——那是下一节 [Summary 策略：middleware](./summary-memory.md) 的内容。

## 切换、克隆、删除 thread

每个 `thread_id` 是独立的。日常使用就是新建一个 ID 就行：

```typescript
// 用户开了个新对话
const newConfig = { configurable: { thread_id: crypto.randomUUID() } };
await agent.invoke({ messages: [...] }, newConfig);
```

**克隆**一个 thread 用于分支调试（比如"如果用户当时换种问法会怎样"）：

```typescript
const snapshots = [];
for await (const s of agent.getStateHistory(config)) {
  snapshots.push(s);
}
const earlier = snapshots[5]; // 比如回到第 5 个 checkpoint

// 从这里岔出去，往一个新 thread 写后续状态
const branchConfig = {
  configurable: {
    thread_id: "branch-1",
    checkpoint_id: earlier.config.configurable!.checkpoint_id,
  },
};
```

**清空** thread 没有官方一键 API，最干净的方法是直接换一个新的 `thread_id`。如果非要清掉某个 thread 的存储（GDPR 等合规场景），就用底层数据库语句删——`PostgresSaver` 默认表名 `checkpoints`，按 `thread_id` 删即可。

## 一个完整可跑的例子

```typescript
// chat-bot.ts
import { createAgent, createMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { trimMessages } from "@langchain/core/messages";
import readline from "node:readline";

const trimmer = trimMessages({
  maxTokens: 3000,
  strategy: "last",
  tokenCounter: (msgs) =>
    msgs.reduce((s, m) => s + (typeof m.text === "string" ? m.text.length / 3 : 0), 0),
  includeSystem: true,
  startOn: "human",
});

const windowMw = createMiddleware({
  name: "window",
  beforeModel: async (state) => ({ messages: await trimmer.invoke(state.messages) }),
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  systemPrompt: "你是一个友好的中文助手。回答尽量简短。",
  middleware: [windowMw],
  checkpointer: new MemorySaver(),
});

// CLI 对话循环，所有对话都在同一个 thread
const config = { configurable: { thread_id: "cli-session" } };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

console.log("输入 quit 退出\n");
while (true) {
  const input = (await ask("你: ")).trim();
  if (input === "quit") break;

  const res = await agent.invoke(
    { messages: [{ role: "user", content: input }] },
    config
  );

  const last = res.messages.at(-1);
  console.log(`AI: ${last?.text ?? ""}\n`);
}
rl.close();
```

跑起来：

```
你: 我叫张三，在做 LangChain.js 项目
AI: 你好张三，做的什么类型的项目？
你: 一个客服 bot
AI: 客服场景挺合适，要不要先聊聊数据源？
你: 我刚才叫什么？
AI: 你叫张三。
你: quit
```

第三轮的"我刚才叫什么"能答对，靠的就是 `checkpointer` 自动管理的 thread 状态。

## 容易踩的坑

**坑 1：忘了传 `thread_id`**

```typescript
await agent.invoke({ messages: [...] }); // 错：没有 config
```

没传 `thread_id` 的话，checkpointer 不起作用，每次都是全新会话。`createAgent` 不会报错，只会"安静地无状态"，这是最迷惑的 bug。我的建议：项目里包一层 helper，强制要求 `thread_id`。

**坑 2：把 user_id 当成 thread_id**

`thread_id` 是**会话**级别的标识，不是用户级。同一个用户开两个聊天窗口应该有两个 `thread_id`。用户级的"长期记忆"是 `store` 的活，见第 4、6 节。

**坑 3：忘了 `await setup()`**

`PostgresSaver` 第一次用之前必须 `await checkpointer.setup()`，否则查表会报"relation does not exist"。这一步只需要做一次，可以放进部署脚本而不是每次启动都跑。

**坑 4：`beforeModel` 裁剪后历史丢了**

不会丢。`beforeModel` 返回的新 messages 只影响**这次模型调用**，不会被写回 checkpoint。完整历史一直在 checkpoint 里。如果你的目标真是"把旧消息从存储里抹掉"——那是不同问题，需要自己写定期任务清理 checkpoint 表。

## 小结

短期记忆在 1.x 里就一行配置：`createAgent({ ..., checkpointer })`。开发用 `MemorySaver`，单机用 `SqliteSaver`，生产用 `PostgresSaver`。`thread_id` 是会话标识，调用 `invoke` 时必须传。

历史太长的问题用 `beforeModel` middleware + `trimMessages` 解决；完整历史仍然安全地躺在 checkpoint 里。

下一节 [Summary 策略：middleware](./summary-memory.md) 讲一种更聪明的策略——不只是裁剪，而是把旧消息**压缩成摘要**塞回 prompt。

参考文档：[LangGraph Persistence](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
