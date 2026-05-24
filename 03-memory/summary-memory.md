---
title: Summary 策略 - 用 middleware 压缩历史
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/V5Dzw4BabiS6L8k1sQOctLqOngc"
last_synced: "2026-05-25T02:41:26+08:00"
---

> 模块 03 - 记忆系统 | 第 3 节 | 前置：[短期记忆 - thread-based checkpointer](./buffer-memory.md)

## 为什么需要"摘要式"记忆

上一节用 `trimMessages` 在 `beforeModel` 里把旧消息直接丢掉。这套方案有个明显问题：

> 用户在第 3 轮说了自己的名字叫张三，到第 80 轮时，"我叫张三"已经被裁剪窗口扔了。结果模型完全不知道用户的身份。

裁剪是有损的，且损得很粗暴——按时间，不按重要性。Summary 策略要解决的就是这个：**旧消息不是被丢弃，而是被 LLM 压缩成一句摘要塞回去**。

老 LangChain 里这套叫 `ConversationSummaryMemory` / `ConversationSummaryBufferMemory`。1.x 把它从一个独立的 Memory 类升级成**一段你自己写的 middleware**，可以精确控制压缩时机、压缩 prompt、保留窗口大小。

## Summary middleware 的设计

整体思路：

1. `beforeModel` 钩子检查当前消息条数（或 token 数）
2. 超过阈值时，取最早的 N 条交给一个轻量模型生成摘要
3. 把那 N 条原始消息**从 state 中替换**为一条 system message（内容是摘要）
4. 这个变化会写回 checkpoint，下次接着 trim

下面是一个完整可用的实现：

```typescript
// summary-middleware.ts
import { createMiddleware } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  BaseMessage,
  SystemMessage,
  RemoveMessage,
} from "@langchain/core/messages";

const summarizer = new ChatAnthropic({
  model: "claude-haiku-4-5", // 摘要用便宜模型
  temperature: 0,
});

// 触发阈值与窗口大小
const TRIGGER_AT = 20;  // 消息条数超过 20 触发
const KEEP_RECENT = 6;  // 保留最近 6 条原始消息

async function summarize(messages: BaseMessage[], oldSummary: string): Promise<string> {
  const dialog = messages
    .map((m) => {
      const role = m.getType() === "human" ? "用户" : m.getType() === "ai" ? "助手" : m.getType();
      const text = typeof m.text === "string" ? m.text : "";
      return `${role}: ${text}`;
    })
    .join("\n");

  const res = await summarizer.invoke([
    new SystemMessage(
      `你是对话摘要器。请把下面这段对话压缩成一段简洁摘要，保留：用户身份、偏好、关键决定、待办。
当前已有的旧摘要（可能为空）：
${oldSummary || "（无）"}

新的对话内容：
${dialog}

输出更新后的完整摘要（不要寒暄，直接给摘要正文）：`
    ),
  ]);

  return typeof res.text === "string" ? res.text : "";
}

export const summaryMiddleware = createMiddleware({
  name: "summary",
  stateSchema: {
    // 把"当前摘要"作为自定义 state 字段
    summary: { value: (a: string, b: string) => b ?? a, default: () => "" },
  },
  beforeModel: async (state) => {
    const messages = state.messages as BaseMessage[];
    if (messages.length < TRIGGER_AT) return;

    // 拿出要被压缩的旧消息
    const toCompress = messages.slice(0, messages.length - KEEP_RECENT);
    const newSummary = await summarize(toCompress, state.summary ?? "");

    // 用 RemoveMessage 标记把旧消息从历史里移除
    const removals = toCompress.map((m) => new RemoveMessage({ id: m.id! }));

    // 把摘要作为一条 system message 拼到最前面
    const summaryMessage = new SystemMessage(`历史对话摘要：\n${newSummary}`);

    return {
      messages: [...removals, summaryMessage],
      summary: newSummary,
    };
  },
});
```

关键点拆解：

- **`createMiddleware` 是 1.x 标准做法**。`stateSchema` 字段用于扩展 state，往里塞一个 `summary` 字符串。middleware 声明的 `stateSchema` 会和外层 graph 的 state schema 做浅合并：在 middleware 内部能读写自己声明的字段，外层 `agent.invoke` 的返回结果里也能拿到这些字段。具体合并规则和生命周期见 [Middleware 系统](../05-agent-architecture/middleware.md)
- **`RemoveMessage` 是真正的删除**。它跟普通消息一起 push 进 state，LangGraph 会把它和被引用的消息一起从历史里抹掉
- **摘要本身是一条 SystemMessage**。下次模型 invoke 时，前面是摘要、后面是最近 6 条原始消息，模型同时看到"远期压缩" + "近期全量"，等于老版本的 `ConversationSummaryBufferMemory`

## 把 middleware 装到 Agent 上

```typescript
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { summaryMiddleware } from "./summary-middleware";

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  systemPrompt: "你是一个会记住用户信息的助手。",
  middleware: [summaryMiddleware],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: "long-chat" } };

// 模拟一段超长对话
const turns = [
  "我叫张三，在北京做后端开发",
  "技术栈是 Go 和 Python",
  "最近在学 LangChain.js",
  "想做一个客服 bot",
  "数据源是飞书云文档",
  // ... 中间省略 30 轮 ...
  "回顾一下我的情况，给个学习路线",
];

for (const t of turns) {
  await agent.invoke({ messages: [{ role: "user", content: t }] }, config);
}

// 检查最终 state
const final = await agent.getState(config);
console.log("当前消息数:", final.values.messages.length);
console.log("当前摘要:", final.values.summary);
```

跑过 20 轮之后，`final.values.messages` 里会只有摘要 + 最近 6 条原始消息，但 Agent 仍然知道"张三 / 北京 / 后端 / Go / Python / 客服 bot / 飞书文档"——因为这些被摘要捕获了。

## 调优摘要质量

摘要的好坏直接决定 Agent 长程记忆能力。下面是几个我踩坑总结的小经验。

### 用便宜模型做摘要

摘要任务通常不需要顶级模型。我一般用 Haiku 4.5 或 GPT-4o-mini，主对话模型仍然用 Sonnet/Opus。能省 5-10 倍成本。

```typescript
const summarizer = new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 });
const chatModel = "anthropic:claude-sonnet-4-6";
```

### 明确告诉模型保留哪些类别

通用 prompt 会出现"信息漂移"——多次压缩后，关键信息被稀释掉。我会在摘要 prompt 里写硬性要求：

```
保留以下类别，不允许遗漏：
- 用户身份信息（姓名、职业、城市、公司）
- 明确表达的偏好与限制
- 尚未完成的任务、承诺、TODO
- 用户做过的关键决定

可以丢弃：寒暄、重复确认、客套话、过时的临时情绪。
```

### 结构化输出

如果场景固定（比如客服），强制摘要为结构化格式：

```typescript
const STRUCTURED_PROMPT = `输出格式（JSON）：
{
  "user_profile": { "name": "", "role": "" },
  "topics": [],
  "decisions": [],
  "pending": []
}`;
```

JSON 格式的摘要在后续 prompt 里更紧凑，模型也更容易"按字段读"。

### 不要每次都压缩

频繁压缩会显著增加成本和延迟。我的经验是 `TRIGGER_AT = 20` / `KEEP_RECENT = 6` 在客服类场景比较平衡。如果对话密度高（每轮内容很长），可以基于 token 数而不是条数：

```typescript
beforeModel: async (state) => {
  const totalTokens = estimateTokens(state.messages);
  if (totalTokens < 6000) return;
  // ...
}
```

## 成本权衡

跑摘要意味着多一次模型调用。值不值，看对话长度：

| 对话轮数 | 不摘要的 prompt token | 用 summary middleware 后 | 额外摘要成本 |
|---------|---------------------|------------------------|-------------|
| 10 | ~2,000 | ~2,000（未触发） | 0 |
| 30 | ~6,000 | ~2,500 | ~1 次摘要调用 |
| 100 | ~20,000 | ~3,000 | ~5 次摘要调用 |
| 500 | 超 context | ~3,500 | ~25 次摘要调用 |

对话短的时候纯亏；对话超过 20-30 轮，summary 在 token 总开销上开始占优；对话超过 100 轮，几乎是唯一可行的方案。

判断原则：**如果你的 Agent 是单次任务型（用完即扔），别用 summary。如果是长期陪伴型（客服、伙伴、教练），summary 几乎必备**。

## 和 RemoveMessage 配合的注意事项

`RemoveMessage` 是个强大也容易出错的工具：

- 被 remove 的消息**必须有 id**。LangChain 1.x 的消息默认就有 id，自己手动 new 的消息要补 id
- 不要 remove 还没出现在 state 里的消息——会报错
- 删除工具调用对（AIMessage 带 tool_calls + ToolMessage 结果）时要**成对**删，否则模型会困惑

LangGraph 的 messages channel 用的是 `add_messages` reducer，没办法用 `return { messages: [...] }` 直接覆盖。要让摘要在 checkpoint 里持续存在，必须用 `RemoveMessage` 真正删旧消息。这点不少人踩过坑。

## 完整可跑的客服 bot 示例

```typescript
// support-bot.ts
import { createAgent, createMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  BaseMessage,
  SystemMessage,
  RemoveMessage,
} from "@langchain/core/messages";

const summarizer = new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 });

const TRIGGER = 16;
const KEEP = 6;

async function buildSummary(toCompress: BaseMessage[], oldSummary: string) {
  const dialog = toCompress
    .map((m) => `${m.getType()}: ${typeof m.text === "string" ? m.text : ""}`)
    .join("\n");

  const res = await summarizer.invoke([
    new SystemMessage(
      `你是客服对话摘要器。压缩下面对话，按以下结构输出：
- 客户身份与诉求
- 已提供的解决方案
- 客户情绪
- 未解决事项

旧摘要：${oldSummary || "（无）"}

新对话：
${dialog}`
    ),
  ]);
  return typeof res.text === "string" ? res.text : "";
}

const summaryMw = createMiddleware({
  name: "summary",
  stateSchema: {
    summary: { value: (a: string, b: string) => b ?? a, default: () => "" },
  },
  beforeModel: async (state) => {
    const msgs = state.messages as BaseMessage[];
    if (msgs.length < TRIGGER) return;

    const cut = msgs.length - KEEP;
    const toCompress = msgs.slice(0, cut);
    const newSummary = await buildSummary(toCompress, state.summary ?? "");

    return {
      messages: [
        ...toCompress.map((m) => new RemoveMessage({ id: m.id! })),
        new SystemMessage(`【客服上下文摘要】\n${newSummary}`),
      ],
      summary: newSummary,
    };
  },
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  systemPrompt: "你是一名耐心的客服。优先调用历史摘要里的信息。",
  middleware: [summaryMw],
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: "customer-A-001" } };

const turns = [
  "你好，我是用户 A，订单号 12345，发货一周还没收到",
  "上面写的物流单号是 SF1234567890",
  "我之前催过两次都没人理",
  "我有点生气了，要求赔偿",
  "我希望明天就能拿到货",
  "我可以接受发顺丰特快",
  "另外，我下周要出差，得在周三之前收到",
  "我家地址是北京朝阳望京 SOHO 1 号楼",
  "电话是 138 0000 0000",
  "你能帮我升级处理吗？",
  "好的，那你回复我一下进度",
  "我先去吃午饭",
  "下午我会盯着这个工单",
  "如果有问题随时联系我",
  "现在能告诉我一下我的诉求总结吗？",
  "我之前提到的物流单号是多少？",
];

for (const t of turns) {
  const r = await agent.invoke({ messages: [{ role: "user", content: t }] }, config);
  console.log(`\n用户: ${t}`);
  console.log(`客服: ${r.messages.at(-1)?.text}`);
}

const finalState = await agent.getState(config);
console.log("\n=== 最终 state ===");
console.log("消息条数:", finalState.values.messages.length);
console.log("摘要:\n", finalState.values.summary);
```

跑这段会观察到：第 16 轮触发摘要后，消息条数永远稳定在 7-8 条左右（1 条摘要 + 6 条最近原始消息 + 当前轮），但 Agent 仍然能答对"物流单号 SF1234567890"——这个信息被摘要保住了。

## 小结

1.x 把 Summary 记忆从一个 Memory 类升级成了一段你自己写的 middleware。核心模式：`beforeModel` 钩子里检查长度，用便宜模型压缩旧消息，用 `RemoveMessage` 删除原始消息，注入一条 SystemMessage 形式的摘要。

这种写法的好处是完全可控——压缩时机、prompt、保留窗口、摘要结构都在你手里。

下一节 [VectorStore 记忆作为工具](./vectorstore-memory.md) 引入第三种思路：不在 prompt 里"塞历史"，而是把"检索历史"作为一个工具暴露给 Agent，让它自己决定要不要回忆。

参考文档：[LangGraph Persistence](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)、[LangGraph Middleware](https://langchain-ai.github.io/langgraphjs/concepts/agents/#middleware)。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
