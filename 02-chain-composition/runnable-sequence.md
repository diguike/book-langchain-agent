---
title: RunnableSequence
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/EzXZwevp7iQKVnkx6JDceP4Xn5b"
last_synced: "2026-05-25T02:41:00+08:00"
---

> 模块 02 - Chain 组合 | 前置知识：[01-核心抽象](../01-core-abstractions/) 中的 Runnable 接口与 LCEL

## 为什么我从 RunnableSequence 讲起

一条真实的 LLM 链路从来不止一步。我做一个最简单的"回答用户问题"功能，至少要走：构造 prompt → 调模型 → 解析输出 → 后处理。这四步如果用普通函数串起来，参数传递、错误处理、流式支持都得自己写一遍；用 LCEL (LangChain Expression Language) 组装，这些能力开箱即用。

`RunnableSequence` 是 LCEL 中最基础的组合原语：把多个 `Runnable` 按顺序拼成一条流水线，前一个的输出就是后一个的输入。这一节把它讲透，后面的 Parallel / Branch / Streaming 都建立在它的基础上。

LCEL 的概念页面在官方文档：[Runnables](https://docs.langchain.com/oss/javascript/langchain/runnables)。

## 两种等价写法：`.pipe()` 和 `RunnableSequence.from()`

```typescript
import { RunnableSequence } from "@langchain/core/runnables";

// 写法 1：显式构造
const chain = RunnableSequence.from([step1, step2, step3]);

// 写法 2：链式 pipe
const chain = step1.pipe(step2).pipe(step3);
```

两种写法运行时完全等价，`.pipe()` 内部就是创建一个 `RunnableSequence`。我自己的习惯：

- **三步以内**用 `.pipe()`，读起来像一句话
- **三步以上**或动态拼装用 `RunnableSequence.from([...])`，每一步独占一行

## 最小可运行示例

我先把这条链跑起来：

```typescript
// chain-sequence.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

// prompt: 把变量插进模板
const prompt = ChatPromptTemplate.fromTemplate(
  "用一句话解释什么是 {concept}",
);

// 模型：用 GPT-4o 做演示，正式项目按场景选 Claude Sonnet 4.6 / GPT-5
const model = new ChatOpenAI({ model: "gpt-4o" });

// parser: 把 AIMessage 转成纯字符串
const parser = new StringOutputParser();

const chain = prompt.pipe(model).pipe(parser);

const result = await chain.invoke({ concept: "量子纠缠" });
console.log(result);
// => "量子纠缠是指两个粒子无论相距多远都能瞬间相互影响的量子力学现象。"
```

运行：

```bash
OPENAI_API_KEY=sk-xxx npx tsx chain-sequence.ts
```

三步的类型自动接龙：

- `prompt`：`Runnable<{ concept: string }, ChatPromptValue>`
- `model`：`Runnable<ChatPromptValue, AIMessage>`
- `parser`：`Runnable<AIMessage, string>`

`chain` 推导出来就是 `Runnable<{ concept: string }, string>`。下面这种调用会被 TypeScript 在编译期拦下来：

```typescript
// [bad] 编译期报错：缺少 concept 字段
await chain.invoke({ topic: "黑洞" });
```

## 在链里插入普通函数

`.pipe()` 接受的不只是 Runnable，普通函数也可以——LangChain 会自动把它包装成 `RunnableLambda`：

```typescript
const chain = prompt
  .pipe(model)
  .pipe(parser)
  // 自动包装成 RunnableLambda
  .pipe((text: string) => text.toUpperCase());
```

注意一个坑：链里嵌函数时，TypeScript 不一定能推断出参数类型。养成显式标注的习惯：

```typescript
// [bad] 类型断裂
.pipe((input) => input.length)

// [ok] 显式标注
.pipe((input: string) => input.length)
```

## 单向管道：中间结果怎么带下去

`RunnableSequence` 的数据流是严格单向的，每一步只能看到上一步的输出。但实际场景里我经常需要把"用户原始输入"一路带到最后用，这时候 `RunnablePassthrough.assign()` 就派上用场。

```typescript
import { RunnablePassthrough } from "@langchain/core/runnables";

const chain = RunnablePassthrough.assign({
  // 在原始输入对象上挂一个新字段 answer
  answer: prompt.pipe(model).pipe(parser),
}).pipe(
  (input: { concept: string; answer: string }) =>
    `问题：${input.concept}\n回答：${input.answer}`,
);

const result = await chain.invoke({ concept: "量子纠缠" });
// => "问题：量子纠缠\n回答：量子纠缠是指..."
```

`assign` 的语义是"在原对象上加字段"，不删原字段。这个模式在并行分支和 RAG 链里都会反复出现，下一节 [RunnableParallel](./runnable-parallel.md) 会对比它和 `RunnableParallel` 的差异。

## 运行时参数：用 `context` 不是 `configurable`

运行时参数通过 `context` 字段传入。所有 Runnable 的 `invoke` / `stream` / `batch` 都接受第二个参数：

```typescript
await chain.invoke(
  { concept: "递归" },
  {
    // 运行时上下文：tenantId、userId、abTestGroup 这类业务字段都放这里
    context: { userId: "u_42", tenantId: "acme" },
    // 给本次调用打 tag，便于在 LangSmith 里过滤
    tags: ["demo"],
    runName: "concept-explainer",
  },
);
```

`context` 里的字段会一路传到链中每个 Runnable 里。`RunnableLambda` 的函数签名第二个参数就是这个 config：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const logger = new RunnableLambda({
  func: (input: string, config) => {
    const userId = config?.context?.userId ?? "anonymous";
    console.log(`[${userId}] 接收到输入：${input}`);
    return input;
  },
});
```

## 短路与错误传播

`RunnableSequence` 是 fail-fast 的：任一步抛异常，后面的步骤都不执行，异常直接向调用方冒泡。

```typescript
const risky = RunnableSequence.from([
  (input: string) => {
    console.log("step 1");
    return input;
  },
  (_: string) => {
    throw new Error("API 限流");
  },
  (input: string) => {
    console.log("step 3"); // 永远不会执行
    return input;
  },
]);

try {
  await risky.invoke("hello");
} catch (e) {
  console.error((e as Error).message); // "API 限流"
}
```

这种行为是合理的——一旦数据流被破坏，后续步骤继续跑只会污染日志。需要容错的场景请看 [Fallback 与重试](./fallback-retry.md)。

## 完整示例：四步流水线

把上面的所有要点串起来，写一个完整的产品评论分析链：

```typescript
// review-pipeline.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { z } from "zod";

// 1. 定义结构化输出 schema
const reviewSchema = z.object({
  summary: z.string().describe("一句话总结"),
  pros: z.array(z.string()).describe("优点列表"),
  cons: z.array(z.string()).describe("缺点列表"),
  rating: z.number().min(1).max(5).describe("1-5 评分"),
});

// 2. 用 withStructuredOutput 替代手写 parser
//    1.x 推荐显式传 strategy: "tool"（基于 function calling，最稳）
const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const structuredModel = model.withStructuredOutput(reviewSchema, {
  strategy: "tool",
});

// 3. prompt
const prompt = ChatPromptTemplate.fromTemplate(`
你是一位严谨的产品评测师。请根据用户反馈对产品做结构化评测。

产品名称：{product}
用户反馈：{feedback}
`);

// 4. 后处理：把 rating 渲染成星星
function addRatingDisplay(review: z.infer<typeof reviewSchema>) {
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  return { ...review, display: `${stars} (${review.rating}/5)` };
}

// 5. 组合
const reviewChain = RunnableSequence.from([
  prompt,
  structuredModel,
  addRatingDisplay,
]);

// 6. 执行
const result = await reviewChain.invoke({
  product: "AirPods Pro 2",
  feedback: "降噪很好，续航一般，戴久了耳朵痛",
});

console.log(result);
// {
//   summary: "降噪出色但续航和舒适度有待提升的真无线耳机",
//   pros: ["降噪效果优秀", "音质清晰"],
//   cons: ["续航一般", "长时间佩戴不适"],
//   rating: 3,
//   display: "★★★☆☆ (3/5)",
// }
```

这条链的好处是类型一路打通：`prompt` 接收 `{ product, feedback }`，`structuredModel` 输出 `z.infer<typeof reviewSchema>`，后处理函数的参数类型直接由前一步推出来。改 schema，编译器立刻告诉我哪里要改。

## 实战：多语言翻译流水线

再看一个稍微长一点的例子——三步翻译链：检测源语言 → 翻译 → 评估翻译质量。

```typescript
// translation-pipeline.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { z } from "zod";

const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0.3 });
const parser = new StringOutputParser();

// 子链 1：检测语言
const detectLang = ChatPromptTemplate.fromTemplate(
  "检测以下文本是什么语言，只返回语言名称（English / 中文 / 日本語 ...）：\n{text}",
)
  .pipe(model)
  .pipe(parser);

// 子链 2：翻译
const translate = ChatPromptTemplate.fromTemplate(
  "把以下 {sourceLang} 文本翻译成 {targetLang}，保持原文风格：\n{text}",
)
  .pipe(model)
  .pipe(parser);

// 子链 3：质量评估（结构化输出）
const qualitySchema = z.object({
  score: z.number().min(1).max(10),
  suggestions: z.array(z.string()),
});
const qualityCheck = ChatPromptTemplate.fromTemplate(
  `对比原文和译文，给出 1-10 分和改进建议。
原文（{sourceLang}）：{text}
译文（{targetLang}）：{translation}`,
)
  .pipe(model.withStructuredOutput(qualitySchema, { strategy: "tool" }));

// 主链：把三个子链按顺序串起来，每步都把中间结果合并回输入
const pipeline = RunnableSequence.from([
  async (input: { text: string; targetLang: string }) => ({
    ...input,
    sourceLang: (await detectLang.invoke({ text: input.text })).trim(),
  }),
  async (input) => ({
    ...input,
    translation: await translate.invoke(input),
  }),
  async (input) => ({
    originalText: input.text,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    translation: input.translation,
    quality: await qualityCheck.invoke(input),
  }),
]);

const result = await pipeline.invoke({
  text: "The quick brown fox jumps over the lazy dog.",
  targetLang: "中文",
});

console.log(result);
// {
//   originalText: "The quick brown fox jumps over the lazy dog.",
//   sourceLang: "English",
//   targetLang: "中文",
//   translation: "敏捷的棕色狐狸跳过了那只懒狗。",
//   quality: { score: 8, suggestions: ["可以考虑更文学化的表达"] },
// }
```

这个例子的重点不是翻译本身，而是**用 async 函数充当 Runnable 时怎么传递累积状态**。我每一步都返回一个"原有字段 + 新增字段"的对象，下一步就能拿到全部上下文。这种"逐步增厚"的模式在 LCEL 里非常常用，比 `RunnablePassthrough.assign()` 更灵活。

## 性能注意点

1. **流式输出**：`RunnableSequence` 原生支持 `.stream()`，但只有最后一步是真正流式的，中间步骤会等上一步完整产出。具体哪些节点会阻断流，下一节 [Streaming 流式输出](./streaming.md) 会专门讲。
2. **批量处理**：`chain.batch([input1, input2, ...], { maxConcurrency: 5 })` 可以对多输入并发跑同一条链，充分利用模型 API 的并发额度。注意 `maxConcurrency` 是顶层 config 字段，直接传给 RunnableConfig，不要再嵌到 `batchOptions` 里。
3. **调试**：给关键节点加 `runName` 和 `tags`，在 LangSmith trace 里会方便很多。

## 小结

| 项 | 说明 |
|----|------|
| 构造 | `RunnableSequence.from([...])` 或 `.pipe()` |
| 数据流 | 单向，前一步输出即下一步输入 |
| 类型推导 | TypeScript 泛型自动接龙，跨步骤的类型安全 |
| 运行时参数 | 通过 `{ context: {...} }` 传给 invoke / stream / batch |
| 错误处理 | fail-fast，异常向上传播 |
| 嵌套 | RunnableSequence 自己就是 Runnable，可以嵌套 |

下一节我讲 [RunnableParallel](./runnable-parallel.md)——同一个输入同时跑多个分支，把延迟从"步骤数 × 单步耗时"压到"max(单步耗时)"。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
