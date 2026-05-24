---
title: API 速查表
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/TcI0waerqi2rwTkvWqvcZnOsn5f"
last_synced: "2026-05-25T02:43:42+08:00"
---

> LangChain.js 1.x（写作时主版本 `langchain@1.4.x` / `@langchain/core@1.4.x`）。本表只列 1.x 仍然推荐的 API，已废弃的（`.bind()`、`.map()`、`RemoteRunnable`、`AgentExecutor` 等）一律不写。

## createAgent —— Agent 构建主入口

包：`langchain`。

```typescript
import { createAgent } from "langchain";

const agent = createAgent({
  model,            // string ID 或 BaseChatModel 实例
  tools,            // Tool[]
  systemPrompt,     // string，可选
  middleware,       // Middleware[]，可选
  responseFormat,   // 结构化输出 schema，可选
  stateSchema,      // 自定义 State，可选
  checkpointer,     // 持久化后端，可选
  interrupts,       // typed interrupt 配置，可选
  name,             // Agent 名字（多 Agent 协作时用），可选
});
```

| API | 签名 | 说明 |
|-----|------|------|
| `createAgent(config)` | 见上 | 创建一个 LangGraph 编译后的 Agent |
| `agent.invoke(input, options?)` | `(state) => Promise<state>` | 一次性跑到结束 |
| `agent.stream(input, { streamMode })` | 同上 | 流式拿中间步骤，`streamMode` 见下 |
| `agent.streamEvents(input, { version: "v2" })` | 同上 | 细粒度事件流（token / tool call / 自定义事件） |
| `agent.getState({ configurable: { thread_id } })` | - | 拿当前 thread 的 State 快照 |
| `agent.updateState(config, values)` | - | 在 HITL 恢复前手动改 State |

`streamMode` 取值：`values` / `updates` / `messages` / `debug` / `custom`。

最小示例：

```typescript
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const echo = tool(async ({ text }) => text, {
  name: "echo",
  description: "返回输入的文本",
  schema: z.object({ text: z.string() }),
});

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [echo],
  systemPrompt: "你是一个助手。",
});

await agent.invoke({ messages: [{ role: "user", content: "测试" }] });
```

## Middleware —— 切 Agent 循环的钩子

包：`langchain`。

| API | 切面 | 说明 |
|-----|------|------|
| `createMiddleware({ beforeModel, afterModel, wrapToolCall })` | 自定义 middleware | 三个切点分别在调模型前/后、工具调用包裹 |
| `dynamicSystemPromptMiddleware((state, runtime) => string)` | 动态 system prompt | 从 state / runtime context 动态生成 system prompt |
| `summarizationMiddleware({ model, maxTokens })` | beforeModel | 自动把长对话历史压成摘要 |
| `humanInTheLoopMiddleware({ ... })` | beforeModel | 把某些工具调用拦下来交给人工审批 |

示例：

```typescript
import { createMiddleware } from "langchain";

const logMiddleware = createMiddleware({
  name: "logger",
  async beforeModel(state) {
    console.log("messages:", state.messages.length);
  },
  async wrapToolCall(call, next) {
    const start = Date.now();
    const result = await next(call);
    console.log(`tool ${call.name} took ${Date.now() - start}ms`);
    return result;
  },
});
```

## Chat Models

| API | 包 | 说明 |
|-----|-----|------|
| `new ChatAnthropic({ model, temperature, thinkingBudget })` | `@langchain/anthropic` | Claude（Opus/Sonnet/Haiku 4.x） |
| `new ChatOpenAI({ model, temperature })` | `@langchain/openai` | GPT-5 / GPT-4o |
| `new ChatGoogleGenerativeAI({ model })` | `@langchain/google-genai` | Gemini |
| `model.invoke(messages)` | `@langchain/core` | 同步调用，返回 AIMessage |
| `model.stream(messages)` | `@langchain/core` | 流式调用 |
| `model.batch(inputs)` | `@langchain/core` | 批量并发 |
| `model.withStructuredOutput(schema, { strategy })` | `@langchain/core` | 结构化输出，`strategy` 见下节 |

不要再用 `.bindTools()` 预先绑定工具。1.x 把工具绑定交给 `createAgent` 内部统一处理。

## 结构化输出策略

包：`langchain` / `@langchain/core`。

```typescript
import { toolStrategy, providerStrategy } from "langchain";

// 走 tool calling 实现（兼容性最好）
model.withStructuredOutput(schema, { strategy: "tool" });
// 等价写法：
model.withStructuredOutput(toolStrategy(schema));

// 走 provider 原生 strict JSON
model.withStructuredOutput(providerStrategy(schema));
```

| API | 说明 |
|-----|------|
| `toolStrategy(schema)` | 用 tool calling 实现结构化输出，所有支持 tool 的 provider 都能用 |
| `providerStrategy(schema)` | 用 provider 原生结构化能力（如 OpenAI strict JSON Mode） |
| `responseFormat: toolStrategy(schema)` | `createAgent` 参数，让 Agent 的最终输出按 schema 走 |

## ContentBlock —— 统一的消息内容

读消息内容时优先用 `contentBlocks`，不要直接读 `content`：

```typescript
const reply = result.messages.at(-1);

for (const block of reply.contentBlocks) {
  if (block.type === "text") {
    console.log(block.text);
  } else if (block.type === "tool_call") {
    console.log("tool:", block.name, block.input);
  } else if (block.type === "thinking") {
    // Claude extended thinking 思考块
  }
}
```

## Messages

| 类型 | 用途 | 导入 |
|------|------|------|
| `HumanMessage` | 用户消息 | `@langchain/core/messages` |
| `AIMessage` | 模型回复 | `@langchain/core/messages` |
| `SystemMessage` | 系统指令 | `@langchain/core/messages` |
| `ToolMessage` | 工具返回结果 | `@langchain/core/messages` |
| `trimMessages(messages, options)` | 裁剪消息列表 | `@langchain/core/messages` |

简写格式（推荐）：

```typescript
const messages = [
  { role: "system", content: "你是助手。" },
  { role: "user", content: "你好" },
];
```

## Prompts

| API | 说明 |
|-----|------|
| `ChatPromptTemplate.fromMessages([...])` | 聊天 prompt 模板 |
| `PromptTemplate.fromTemplate("...")` | 纯字符串 prompt 模板 |
| `MessagesPlaceholder` | 消息历史占位符 |
| `prompt.invoke({ key: value })` | 填变量 |
| `prompt.pipe(model)` | LCEL 链式连接 |

## Tools

| API | 说明 |
|-----|------|
| `tool(func, { name, description, schema })` | 创建工具（推荐） |
| `class MyTool extends StructuredTool` | 类形式（少用） |
| `TavilySearchResults` | 内置网络搜索工具 |

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const search = tool(
  async ({ query }) => `Result for: ${query}`,
  {
    name: "search",
    description: "搜索网络",
    schema: z.object({ query: z.string() }),
  }
);
```

## Runnables / LCEL

| API | 说明 |
|-----|------|
| `runnable.pipe(next)` | 链式连接 |
| `runnable.invoke(input, { context })` | 单次执行，运行时参数走 `context`（不再用 `configurable`） |
| `runnable.stream(input)` | 流式执行 |
| `runnable.batch(inputs)` | 批量并发 |
| `RunnableLambda.from(fn)` | 把函数包成 Runnable |
| `RunnablePassthrough` | 透传输入 |
| `RunnableParallel` | 并行执行多个 Runnable |
| `RunnableSequence.from([...])` | 顺序执行 |
| `runnable.withConfig({ runName })` | 配运行参数 |
| `runnable.withRetry({ stopAfterAttempt })` | 加重试 |
| `runnable.withFallbacks([fallback])` | 加降级 |

`.bind()` 和 `.map()` 在 1.x 已经移除，不要再用。

## Memory / Checkpointer

包：`@langchain/langgraph/checkpointers` / `@langchain/langgraph-checkpoint-postgres`。

| API | 说明 |
|-----|------|
| `new MemorySaver()` | 进程内 checkpointer，仅做开发 |
| `new PostgresSaver(client)` | Postgres checkpointer（生产推荐） |
| `agent.invoke(input, { configurable: { thread_id } })` | 在 thread 维度跑，State 自动持久化 |
| `agent.getState(config)` | 拿 thread 当前 State |
| `agent.getStateHistory(config)` | 拿 thread 的 State 时间线（用于回放） |

递归上限 `recursionLimit`（LangGraph 默认 25，每经过一个节点 +1，避免死循环）：

```typescript
// 调用时按次设置
await agent.invoke(input, { recursionLimit: 25 });

// 或编译时设置（适用于底层 StateGraph）
graph.compile({ checkpointer, recursionLimit: 25 });
```

## LangGraph 底层 API

包：`@langchain/langgraph`。

| API | 说明 |
|-----|------|
| `Annotation.Root({ ... })` | 定义 State Schema |
| `MessagesAnnotation` | 预定义的 `messages` 字段（带 message reducer） |
| `new StateGraph(StateAnnotation)` | 创建状态图 |
| `graph.addNode(name, fn)` | 加节点 |
| `graph.addEdge(from, to)` | 加固定边 |
| `graph.addConditionalEdges(from, routerFn)` | 加条件路由 |
| `graph.compile({ checkpointer, interrupts })` | 编译图 |
| `interrupt(value)`（在节点内调用） | 触发 typed interrupt，挂起等待 |
| `Command({ goto, update })` | 节点返回 Command 显式控制下一跳和 State 更新 |

## Streaming

| 方式 | 用法 | 适合 |
|------|------|------|
| `agent.stream(input, { streamMode: "messages" })` | 拿 token-by-token | 聊天 UI |
| `agent.stream(input, { streamMode: "updates" })` | 拿节点级日志 | 调试、监控 |
| `agent.stream(input, { encoding: "text/event-stream" })` | 直接拿 SSE 字节流 | HTTP SSE 透传 |
| `agent.streamEvents(input, { version: "v2" })` | 细粒度事件（含工具调用、自定义事件） | 复杂前端 |

SSE 简化写法：

```typescript
return new Response(
  agent.stream(input, { encoding: "text/event-stream" }),
  { headers: { "Content-Type": "text/event-stream" } }
);
```

## Embeddings

| API | 包 |
|-----|-----|
| `new OpenAIEmbeddings({ model: "text-embedding-3-small" })` | `@langchain/openai` |
| `embeddings.embedQuery(text)` | `@langchain/core` |
| `embeddings.embedDocuments(texts)` | `@langchain/core` |

## Vector Stores

| API | 包 |
|-----|-----|
| `MemoryVectorStore.fromDocuments(docs, embeddings)` | `langchain/vectorstores/memory` |
| `PGVectorStore.initialize(embeddings, config)` | `@langchain/community/vectorstores/pgvector` |
| `vectorStore.similaritySearch(query, k)` | `@langchain/core` |
| `vectorStore.similaritySearchWithScore(query, k)` | `@langchain/core` |
| `vectorStore.asRetriever({ k })` | `@langchain/core` |

## Document Loaders / Text Splitters

| API | 说明 |
|-----|------|
| `new TextLoader(path)` | 纯文本文件 |
| `new PDFLoader(path)` | PDF |
| `new CSVLoader(path)` | CSV |
| `new CheerioWebBaseLoader(url)` | 网页 |
| `new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap })` | 递归字符切分（推荐） |
| `new MarkdownTextSplitter()` | Markdown 切分 |

## LangSmith

| API | 说明 |
|-----|------|
| `new Client({ apiKey })` | LangSmith 客户端 |
| `traceable(fn, options)` | 把自定义函数纳入 Trace |
| `client.createDataset(name)` | 创建数据集 |
| `client.createExamples(...)` | 加样本 |
| `evaluate(target, { data, evaluators })` | 跑评估 |
| `pull(promptName)` | 从 Hub 拉 prompt |

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_API_KEY` | Google Gemini |
| `LANGSMITH_TRACING=true` | 启用 LangSmith Tracing |
| `LANGSMITH_API_KEY` | LangSmith API Key |
| `LANGSMITH_PROJECT` | LangSmith 项目名 |
| `TAVILY_API_KEY` | Tavily 搜索 |

`LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` 在 1.x 仍兼容，但官方推荐迁到 `LANGSMITH_*` 命名。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
