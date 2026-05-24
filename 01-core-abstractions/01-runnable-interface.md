---
title: Runnable 接口详解
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/YQC1wXxfhio2qIkHfnKcRwtNnLz"
last_synced: "2026-05-25T02:40:42+08:00"
---

> 模块 01 - 核心抽象 | 前置：[导论](../00-introduction/01-roadmap.md)

`Runnable` 是 LangChain.js 所有组件的统一接口。Chat Model、Prompt Template、Output Parser、检索器，乃至 `createAgent` 返回的 Agent，本质上都是 Runnable。这一节我把 Runnable 接口拆开讲，让你知道这些组件为什么能被 `.pipe()` 串起来，又为什么 `invoke` / `stream` / `batch` 是同一套调用约定。

读完这节，你写后面任何代码——LCEL (LangChain Expression Language) 链、自定义工具、Agent middleware——都会有一种"啊我懂这个对象在干嘛"的感觉。

## 1. 一切皆 Runnable

先看一段最朴素的代码：

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是一个简洁的助手，用一句话回答。"],
  ["human", "{question}"],
]);

const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
const parser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(parser);

const answer = await chain.invoke({ question: "什么是 RAG？" });
console.log(answer);
```

这里出现了四个对象：`prompt` / `model` / `parser` / `chain`。它们都实现了 `Runnable<RunInput, RunOutput>`。`.pipe()` 把前一个的输出类型对接到后一个的输入类型，TypeScript 在编译期就帮你查对不上。

完整的 Runnable 接口大致长这样：

```typescript
interface Runnable<RunInput, RunOutput> {
  // 四种调用方式
  invoke(input: RunInput, options?: RunnableConfig): Promise<RunOutput>;
  batch(inputs: RunInput[], options?: RunnableConfig & { maxConcurrency?: number }): Promise<RunOutput[]>;
  stream(input: RunInput, options?: RunnableConfig): Promise<IterableReadableStream<RunOutput>>;
  streamEvents(input: RunInput, options: { version: "v2" } & RunnableConfig): AsyncGenerator<StreamEvent>;

  // 组合
  pipe<NewOutput>(next: Runnable<RunOutput, NewOutput>): Runnable<RunInput, NewOutput>;

  // 行为修饰
  withConfig(config: RunnableConfig): Runnable<RunInput, RunOutput>;
  withFallbacks(opts: { fallbacks: Runnable[] }): Runnable<RunInput, RunOutput>;
  withRetry(opts?: { stopAfterAttempt?: number }): Runnable<RunInput, RunOutput>;
}
```

接下来逐个讲。

## 2. 四种调用方式

### invoke：一发一收

最常用的方式，给一个输入拿一个输出：

```typescript
const result = await model.invoke([
  { role: "user", content: "你好" },
]);
// result 是 AIMessage
```

`invoke` 是异步的，全部走完才 resolve。适合后端批处理脚本、CLI 工具、不需要逐字展示的场景。

### batch：并行处理多个输入

`batch` 在内部并发跑多个 `invoke`，吞吐量比写 `Promise.all` 自己控制并发要省心：

```typescript
const results = await model.batch(
  [
    [{ role: "user", content: "1+1=?" }],
    [{ role: "user", content: "2+2=?" }],
    [{ role: "user", content: "3+3=?" }],
  ],
  {
    maxConcurrency: 3,        // 同时最多 3 个请求
    returnExceptions: true,   // 单个失败不中断其他
  }
);

for (const item of results) {
  if (item instanceof Error) {
    console.error("失败:", item.message);
  } else {
    console.log(item.content);
  }
}
```

`maxConcurrency` 很关键。LLM Provider 都有 RPM (Requests Per Minute) 限流，不加限制会触发 429 错误。日常 OpenAI / Anthropic 接口我一般设 5 到 10。

### stream：流式拿增量

UI 想要"打字机"效果就用 `stream`：

```typescript
const stream = await model.stream([
  { role: "user", content: "写一段关于咖啡的散文" },
]);

for await (const chunk of stream) {
  // chunk 是 AIMessageChunk
  process.stdout.write(chunk.text);
}
```

`chunk.text` 是这次 chunk 累积到的纯文本（属性 getter，相当于把 contentBlocks 里的 text 块拼起来）。多模态场景请用 `chunk.contentBlocks` 拿到原始块结构。

### streamEvents：拿到所有节点的事件

`streamEvents` 比 `stream` 更细。它把链中每个节点的开始、结束、错误、流式片段都推出来。调试和监控用：

```typescript
const eventStream = chain.streamEvents(
  { question: "什么是向量数据库？" },
  { version: "v2" }
);

for await (const event of eventStream) {
  if (event.event === "on_chat_model_stream") {
    process.stdout.write(event.data.chunk.text);
  } else if (event.event === "on_chain_end") {
    console.log(`\n[节点 ${event.name} 结束]`);
  }
}
```

常用事件：

| event | 触发时机 |
|-------|----------|
| `on_chain_start` | 一个节点开始 |
| `on_chain_end` | 一个节点结束 |
| `on_chat_model_stream` | 模型吐出一个 token chunk |
| `on_chat_model_end` | 模型整段调用结束 |
| `on_tool_start` / `on_tool_end` | 工具节点 |
| `on_chain_error` | 任何节点抛错 |

生产环境流式输出我优先用 `stream`，事件粒度足够时不要上 `streamEvents`——后者事件量大、过滤逻辑复杂、容易把后端 SSE (Server-Sent Events) 推爆。

## 3. RunnableConfig：运行时配置

所有调用方法的第二个参数都是 `RunnableConfig`：

```typescript
interface RunnableConfig {
  callbacks?: Callbacks;       // 自定义回调（接 LangSmith 等）
  tags?: string[];             // 标签，方便 LangSmith 过滤
  metadata?: Record<string, unknown>;  // 元数据
  runName?: string;            // 这次调用的可读名字
  maxConcurrency?: number;     // batch 用
  recursionLimit?: number;     // LangGraph 循环上限
  signal?: AbortSignal;        // 取消信号
  context?: Record<string, unknown>;   // 1.x 新加的运行时上下文
}
```

几个高频用法。

**打标签 + 元数据**，配合 LangSmith 追踪定位某个用户、某个会话：

```typescript
const result = await chain.invoke(
  { question: "..." },
  {
    tags: ["prod", "user-query"],
    metadata: { userId: "u-123", sessionId: "s-456" },
    runName: "QA Chain",
  }
);
```

**取消**，避免用户关掉页面后请求还在烧钱：

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

await chain.invoke({ question: "..." }, { signal: controller.signal });
```

**`context`**，向链或 Agent 内部传运行时参数（比如当前用户的 tier、租户 ID）：

```typescript
await chain.invoke(
  { question: "..." },
  { context: { userId: "u-123", tier: "pro" } }
);
```

Agent 的 middleware、动态 system prompt 都从 `runtime.context` 里取这一份数据。详见 [Middleware 系统](../05-agent-architecture/07-middleware.md)。

## 4. withConfig：把配置黏在 Runnable 上

调用时一遍遍传配置很烦。`withConfig` 返回一个新 Runnable，把默认配置黏上去：

```typescript
const taggedChain = chain.withConfig({
  tags: ["prod"],
  metadata: { component: "qa" },
  runName: "Production QA",
});

await taggedChain.invoke({ question: "..." });
// 自动带上 tags / metadata / runName
```

`withConfig` 是不可变的——返回新对象，原始 `chain` 不变。你可以在不同上下文里链不同的 config。

## 5. withFallbacks：降级链

主模型挂了切到备用模型，这种事在生产里太常见。`withFallbacks` 让降级对上层透明：

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

const primary = new ChatOpenAI({ model: "gpt-5" });
const backup = new ChatAnthropic({ model: "claude-sonnet-4-6", maxTokens: 4096 });

const resilient = primary.withFallbacks({
  fallbacks: [backup],
});

const result = await resilient.invoke([
  { role: "user", content: "你好" },
]);
```

`primary` 抛错就自动调 `backup`。降级链同样是 Runnable，能继续 `.pipe()`、能继续 `.withConfig()`。

整条链也能降级：

```typescript
const primaryChain = prompt.pipe(primary).pipe(parser);
const backupChain = prompt.pipe(backup).pipe(parser);

const safeChain = primaryChain.withFallbacks({ fallbacks: [backupChain] });
```

## 6. withRetry：自动重试

网络抖动、Provider 偶发 503，加重试就够了：

```typescript
const retryable = model.withRetry({
  stopAfterAttempt: 3,
  onFailedAttempt: (error, attempt) => {
    console.warn(`第 ${attempt} 次失败：${error.message}`);
    // 抛出非可重试错误来终止
    if (error.message.includes("401")) throw error;
  },
});
```

`withRetry` 内部用指数退避。配合 `withFallbacks` 用：先重试 N 次，再降级——这是我生产环境的常见组合。

```typescript
const robust = model
  .withRetry({ stopAfterAttempt: 3 })
  .withFallbacks({ fallbacks: [backupModel] });
```

## 7. 类型推导：编译期帮你看错

LCEL 的爽点很大一部分来自类型推导。

```typescript
// prompt: Runnable<{ question: string }, ChatPromptValue>
// model:  Runnable<ChatPromptValue, AIMessage>
// parser: Runnable<AIMessage, string>

// chain 自动推为 Runnable<{ question: string }, string>
const chain = prompt.pipe(model).pipe(parser);

await chain.invoke({ question: "你好" });       // OK
await chain.invoke({ wrong: "你好" });          // 编译报错
await chain.invoke("你好");                     // 编译报错
chain.pipe((s: number) => s + 1);              // 编译报错：string 接不上 number
```

构建几十节的复杂链时，这种类型检查直接帮我省了大量 console.log。

## 8. 自定义 Runnable：RunnableLambda 和继承 Runnable

90% 的场景你不需要写新类，用 `RunnableLambda` 把一个函数包成 Runnable 就行：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const upperCase = RunnableLambda.from(async (input: string) => {
  return input.toUpperCase();
});

const chain = upperCase.pipe(prompt).pipe(model).pipe(parser);
```

如果需要保留更多状态（比如自带缓存的 Runnable），继承 `Runnable` 类：

```typescript
import { Runnable, RunnableConfig } from "@langchain/core/runnables";

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

// 一个简单的内存缓存包装器
class CachedRunnable<I, O> extends Runnable<I, O> {
  lc_namespace = ["custom"];

  private cache = new Map<string, CacheEntry<O>>();

  constructor(
    private inner: Runnable<I, O>,
    private ttlMs: number = 60_000
  ) {
    super();
  }

  async invoke(input: I, options?: RunnableConfig): Promise<O> {
    const key = JSON.stringify(input);
    const hit = this.cache.get(key);

    if (hit && Date.now() - hit.timestamp < this.ttlMs) {
      return hit.value;
    }

    const value = await this.inner.invoke(input, options);
    this.cache.set(key, { value, timestamp: Date.now() });
    return value;
  }
}

const cached = new CachedRunnable(chain, 5 * 60_000);

await cached.invoke({ question: "什么是 AI？" });  // miss
await cached.invoke({ question: "什么是 AI？" });  // hit
```

继承 `Runnable` 必须实现 `invoke` 和声明 `lc_namespace`。`stream` / `batch` 等方法基类有默认实现，需要时再覆写。

## 9. 条件分支：RunnableBranch

简单的路由用 `RunnableBranch`：

```typescript
import { RunnableBranch } from "@langchain/core/runnables";

const router = RunnableBranch.from([
  // 命中条件 + 走的链
  [
    (input: { text: string }) => input.text.length > 1000,
    summarizeChain,
  ],
  [
    (input: { text: string }) => input.text.includes("```"),
    codeAnalysisChain,
  ],
  // 默认链
  qaChain,
]);

await router.invoke({ text: userInput });
```

更复杂的拓扑（带循环、带状态、需要多 Agent 协作）就不要硬塞到 LCEL 里，直接上 [LangGraph](https://langchain-ai.github.io/langgraphjs/) 的 `StateGraph`。LCEL 适合 DAG (Directed Acyclic Graph)，LangGraph 适合带环的图。

## 10. 可视化与调试

每个链都有 `.getGraph()`：

```typescript
const graph = chain.getGraph();
console.log(JSON.stringify(graph.toJSON(), null, 2));
```

但更实用的方式是接 [LangSmith](https://www.langchain.com/langsmith)：

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=my-project
```

设了环境变量之后每次 `invoke` / `stream` 都会自动上传 trace。你能在 web 控制台里看到每个节点的输入、输出、token 数、耗时。这件事 7 模块 [可观测性](../07-observability/02-langsmith-tracing.md) 会展开讲。

## 小结

| 接口 / 方法 | 干什么 |
|-------------|--------|
| `invoke` / `batch` / `stream` / `streamEvents` | 四种调用方式 |
| `pipe` | 把两个 Runnable 串成新 Runnable |
| `withConfig` | 给 Runnable 黏上默认配置（tags / metadata / context） |
| `withFallbacks` | 主路径失败时切到备用路径 |
| `withRetry` | 自动重试，常配合 fallback |
| `RunnableLambda` | 把普通函数包成 Runnable |
| `RunnableBranch` | 简单条件路由 |

Runnable 是 LangChain.js 的最小公分母。模型、提示、解析器、整条 LCEL 链、`createAgent` 返回的 Agent，全部遵守同一套调用约定。下一节 [LCEL 表达式语言](./02-lcel.md) 会用 `.pipe()` 把这些组件串成第一条真正能跑的链。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
