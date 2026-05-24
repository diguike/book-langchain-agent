---
title: 常见错误与排查
feishu_url: ""
last_synced: ""
---

> 这一章只收 LangChain.js 1.x 时代踩过的坑。环境是 Node.js 22+，`langchain@1.4.x`、`@langchain/core@1.4.x`、`@langchain/langgraph@1.x`。

## 一、Agent 不调工具

**症状**：调 `agent.invoke()`，模型直接编了个答案出来，根本没碰我注册的工具。

**原因**（按频率）：

1. 工具 `description` 写得太抽象，模型看不出来什么场景该用
2. `systemPrompt` 里没明确说"涉及外部数据必须调工具，不要凭记忆回答"
3. 用了能力太弱的模型（如 Haiku 在工具数量多时容易选错），或者 `temperature` 太高
4. 把模型预绑过 `.bindTools()` 又传给 `createAgent`，重复绑定行为未定义

**解决**：

- description 写清楚"什么场景用 + 输入是什么 + 返回什么"，例：
  ```
  「查询某个城市今天的天气，输入是中文城市名（如 "北京"），返回温度和天气描述。」
  ```
- system prompt 里加一句明确的纪律："涉及实时数据时必须先调用工具，不要凭已有知识回答。"
- 复杂工具列表换 Sonnet 4.6 或 GPT-5
- **不要**在传给 `createAgent` 之前对 model 调 `.bindTools()`——1.x 由 `createAgent` 内部统一绑定
- 开 LangSmith Tracing 看模型的实际输入输出，比猜更快

## 二、`stream` 没数据出来

**症状**：`for await (const chunk of agent.stream(...))` 循环跑了一遍，但 `chunk` 是空对象或者没拿到 token。

**原因**：

1. 没传 `streamMode`，默认是 `"values"`，每次推送的是整个 State 快照，而不是增量
2. 想要 token 流但用了 `streamMode: "updates"`，updates 是节点级而不是 token 级
3. 把 `agent.stream()` 误写成 `agent.invoke()`

**解决**：

```typescript
// 聊天 UI：要 token-by-token 流
for await (const chunk of agent.stream(input, { streamMode: "messages" })) {
  const [message, metadata] = chunk;
  for (const block of message.contentBlocks ?? []) {
    if (block.type === "text") process.stdout.write(block.text);
  }
}

// 调试 / 监控：要每个节点的状态变化
for await (const chunk of agent.stream(input, { streamMode: "updates" })) {
  console.log(chunk);
}
```

HTTP SSE 透传直接用 `encoding: "text/event-stream"`：

```typescript
return new Response(
  agent.stream(input, { encoding: "text/event-stream" }),
  { headers: { "Content-Type": "text/event-stream" } }
);
```

## 三、Checkpointer `thread_id` 冲突 / 不对话

**症状**：

- 报错 `CheckpointerError: thread_id required`
- 或者：两个用户的对话历史串了
- 或者：换了一个 `thread_id` 之后还能拿到上一段对话

**原因**：

1. 给 Agent 配了 `checkpointer` 但 `invoke` 时没传 `thread_id`
2. 多个用户共用了同一个 `thread_id`（典型错误：用全局变量当 thread_id）
3. 用了 `MemorySaver` 在多进程部署下，每个进程内存独立、状态不共享

**解决**：

```typescript
// 1. 每次 invoke 必须带 thread_id
await agent.invoke(input, {
  configurable: { thread_id: `${userId}:${conversationId}` },
});

// 2. thread_id 必须按"用户 + 会话"维度生成，不要复用
const threadId = `${userId}:${conversationId}`;

// 3. 多进程部署用 Postgres checkpointer 而不是 MemorySaver
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
await checkpointer.setup();
```

## 四、Middleware 顺序导致行为奇怪

**症状**：加了好几个 middleware 之后，发现 prompt 没按预期改、或者工具调用没按预期被拦截。

**原因**：middleware 是按数组顺序执行的，且不同 hook 各有自己的执行顺序：

- `beforeModel`：按数组**正序**执行
- `afterModel`：按数组**反序**执行（最后加的最先看到模型输出）
- `wrapToolCall`：按数组顺序**嵌套**（最后加的在最内层）

错误示例——动态 prompt middleware 放在 summarization 后面：

```typescript
middleware: [
  summarizationMiddleware({ model, maxTokens: 8000 }),
  dynamicSystemPromptMiddleware((state) => `用户 tier: ${state.userTier}`),
]
// 问题：summarization 已经先压缩了 messages，dynamic prompt 拿到的是压缩后的 state
```

**解决原则**：

1. 上下文改写类 middleware（动态 prompt、PII 脱敏）放前面
2. 摘要 / 裁剪类 middleware 放后面，保证它们看到的是最终上下文
3. 工具拦截类 middleware（HITL、限流）放最外层，方便观察

## 五、结构化输出 schema 不匹配

**症状**：

- `OutputParserException: Failed to parse structured output`
- 或者：返回的对象有些字段是 `undefined`、类型不对

**原因**：

1. Zod schema 用了 `.optional()` 但 prompt 没说什么时候可以省略，模型干脆全省了
2. 用了 `providerStrategy` 但 provider 实际不支持该 schema 的某些特性（如递归类型）
3. 模型版本不支持结构化输出（少见，但本地化模型偶发）

**解决**：

- 优先用 `toolStrategy`，兼容性最好：

```typescript
import { toolStrategy } from "langchain";

model.withStructuredOutput(schema, { strategy: "tool" });
// 或：
const structured = model.withStructuredOutput(toolStrategy(schema));
```

- schema 里每个字段都加 `.describe(...)`，模型才知道每个字段填什么
- 用了 `responseFormat` 时把同样的 schema 也写到 system prompt 里作为冗余约束：

```typescript
createAgent({
  model,
  tools,
  systemPrompt: `
    回答用户问题，最终用以下 JSON 格式输出：
    { "answer": "...", "confidence": 0-1 }
  `,
  responseFormat: toolStrategy(z.object({
    answer: z.string().describe("最终答案"),
    confidence: z.number().min(0).max(1).describe("置信度"),
  })),
});
```

## 六、`message.content` 在多模态消息上是空字符串

**症状**：模型返回的消息 `result.messages.at(-1).content` 是空字符串，但流式调试里看明明有内容。

**原因**：1.x 把多模态、思考链、工具调用等内容统一到 `contentBlocks` 上，`content` 只是兼容性投影，碰到不能转字符串的块就给空。

**解决**：始终走 `contentBlocks`：

```typescript
const reply = result.messages.at(-1)!;

let text = "";
for (const block of reply.contentBlocks ?? []) {
  if (block.type === "text") text += block.text;
}
console.log(text);
```

## 七、`agent.invoke` 在 HITL 中断点直接报错而不是挂起

**症状**：配了 `interrupts` 想让 Agent 在敏感操作前停下来等审批，结果直接抛 `GraphInterrupt`。

**原因**：1.x 的 typed interrupt 抛 `GraphInterrupt` **本身就是预期行为**——`invoke` 会用异常作为"挂起"信号。需要在外层接住、把 thread state 存下来、等审批回来再 resume。

**解决**：

```typescript
import { GraphInterrupt } from "@langchain/langgraph";
import { Command } from "@langchain/langgraph";

try {
  await agent.invoke(input, { configurable: { thread_id } });
} catch (err) {
  if (err instanceof GraphInterrupt) {
    // 1. 把 interrupt 的 value（typed）存到数据库，推送给审批方
    await saveApprovalRequest(thread_id, err.interrupts[0].value);
    return;
  }
  throw err;
}

// 审批方拿到结果后，恢复执行
await agent.invoke(
  new Command({ resume: { approved: true, reason: "人工确认通过" } }),
  { configurable: { thread_id } }
);
```

## 八、`{ configurable: {...} }` vs `{ context: {...} }`

**症状**：传了运行时参数（比如 `userTier`、`tenantId`），但 middleware 或动态 prompt 里读不到。

**原因**：1.x 把"运行时上下文"从 `configurable` 拆出来到 `context`：

- `configurable.thread_id` / `configurable.checkpoint_ns` 等 LangGraph 内部参数继续用 `configurable`
- 业务运行时参数（自定义字段）改用 `context`

**解决**：

```typescript
await agent.invoke(input, {
  configurable: { thread_id: "..." },  // LangGraph 内部
  context: { userTier: "pro", tenantId: "t-123" },  // 你自己的
});

// middleware 里读
dynamicSystemPromptMiddleware((state, runtime) => {
  return `用户等级：${runtime.context.userTier}`;
});
```

## 九、找不到 `AgentExecutor` / `createReactAgent`

**症状**：复制旧代码报 `Cannot find name 'AgentExecutor'` 或 `Module '@langchain/langgraph/prebuilts' has no exported member 'createReactAgent'`。

**原因**：1.x 把 `AgentExecutor` 这类 legacy API 移到了 `@langchain/classic`，主推 `createAgent` 替代 `createReactAgent`。

**解决**：换写法。新代码直接用：

```typescript
import { createAgent } from "langchain";
```

不要再用 `AgentExecutor`。本书全程不使用。

## 十、`@langchain/core` 多版本共存

**症状**：

- `Peer dependency conflict: @langchain/core@1.4.x vs @langchain/core@0.3.x`
- 类型检查报"两个 BaseMessage 不是同一个类型"

**原因**：你的 `node_modules` 里同时存在两份 `@langchain/core`，通常是某个老 `@langchain/community` 拖进来的。

**解决**：

```bash
npm ls @langchain/core
# 找到拖进来旧版本的包，升级它，或者用 npm overrides 锁版本

# package.json
{
  "overrides": {
    "@langchain/core": "^1.4.0"
  }
}
```

## 通用排查步骤

### 1. 先开 LangSmith Tracing

90% 的 Agent 问题靠看 Trace 就能定位。本地开发设环境变量即可：

```
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=local-dev
```

跑一次，去 [smith.langchain.com](https://smith.langchain.com/) 看 Run 详情。

### 2. 隔离测试模型层

排除是不是模型本身或网络问题：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic({ model: "claude-haiku-4-5" });
const result = await model.invoke("说你好");
console.log(result.contentBlocks);
```

模型层都不通就先解决凭证 / 网络问题。

### 3. 用 `updates` 流模式看 Agent 内部

```typescript
for await (const update of agent.stream(input, { streamMode: "updates" })) {
  console.log(Object.keys(update)[0], "→", update);
}
```

每个 update 对应一个节点完成后的状态变化，能看出 Agent 是停在哪一步、有没有进入工具节点。

### 4. 检查版本一致性

```bash
npm ls | grep langchain
npm ls @langchain/core
```

确保所有 `@langchain/*` 包都基于同一份 `@langchain/core`。

## 性能问题速查

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| 首 token 慢 | 网络冷链路 / provider 冷启动 | 用 LangSmith 看 TTFT；本地试别的 provider 对照 |
| 整体响应慢 | 工具循环步数多 / 模型选大了 | `streamMode: "updates"` 看步数；非复杂推理换 Sonnet/Haiku |
| 偶发超时 | provider 限流 / 网络抖动 | 给模型加 `.withRetry({ stopAfterAttempt: 3 })` |
| 内存涨 | messages 历史没裁 | 加 `summarizationMiddleware` 或在 reducer 里截断 |
| Agent 步数爆炸 | 工具 description 不清 / 无终止条件 | 配 `recursionLimit`；改进 prompt 强制结束条件 |

## 常见误用

| 误用 | 正确做法 |
|------|---------|
| 每次请求 `new ChatAnthropic({ ... })` | 模块顶层创建并复用 |
| 把整篇文档塞进 prompt | 走 RAG 检索相关片段 |
| 用 `MemoryVectorStore` 上线 | 生产用 PGVector / Pinecone / Qdrant |
| 手写 JSON 解析 | 用 `model.withStructuredOutput(toolStrategy(schema))` |
| 把 `thread_id` 写死 | 按 `userId:conversationId` 维度生成 |
| 在 `createAgent` 之前先 `.bindTools()` | 直接把 `tools` 数组交给 `createAgent` |

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
