---
title: LCEL 表达式语言
feishu_url: ""
last_synced: ""
---

> 模块 01 - 核心抽象 | 前置：[Runnable 接口详解](./runnable-interface.md)

LCEL (LangChain Expression Language) 不是一种新语法，而是一组组合 Runnable 的工具：`.pipe()` 串联、`RunnableParallel` 分叉、`RunnableLambda` 插入自定义函数、`RunnablePassthrough` 透传输入。这一节把这些工具的用法过一遍，让你能用十几行代码搭出一条完整的"输入 → 提示 → 模型 → 解析 → 输出"管线。

LCEL 适合 DAG (Directed Acyclic Graph) 形态的管线——数据从一端进、另一端出，中间可以分叉合并但不绕回。带循环的 Agent 工作流不该硬塞进 LCEL，应该用 [LangGraph](https://langchain-ai.github.io/langgraphjs/)。

## 1. pipe：最基本的串联

`.pipe()` 把前一个 Runnable 的输出连到后一个的输入。这条链是我们最常写的形态：

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是翻译助手，把中文翻译成 {language}，只输出译文。"],
  ["human", "{text}"],
]);

const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
const parser = new StringOutputParser();

// 数据流向：{ language, text } → prompt → model → parser → string
const chain = prompt.pipe(model).pipe(parser);

const result = await chain.invoke({
  language: "英文",
  text: "今天天气真好",
});
// "The weather is really nice today."
```

每一步的输出类型必须能对接下一步的输入类型，TypeScript 编译期就帮你查。

数据在链里的形态变化：

```
{ language: "英文", text: "今天天气真好" }
  ↓ prompt.invoke()
[SystemMessage("你是翻译助手..."), HumanMessage("今天天气真好")]
  ↓ model.invoke()
AIMessage({ contentBlocks: [{ type: "text", text: "The weather..." }] })
  ↓ parser.invoke()
"The weather is really nice today."
```

## 2. RunnableSequence：显式构造序列

`a.pipe(b).pipe(c)` 底层等价于 `RunnableSequence.from([a, b, c])`：

```typescript
import { RunnableSequence } from "@langchain/core/runnables";

const chain = RunnableSequence.from([prompt, model, parser]);
```

`RunnableSequence` 也是 Runnable，可以继续 `.pipe()`。两种写法日常都行，`.pipe()` 在小链路里更顺手，`RunnableSequence.from` 在批量构造、组件来自配置时更清晰。

## 3. RunnableLambda：插入自定义函数

链中间需要做点自定义处理时，用 `RunnableLambda.from()` 把一个普通函数变 Runnable：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const wordCounter = RunnableLambda.from((text: string) => ({
  text,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  charCount: text.length,
}));

const chain = prompt
  .pipe(model)
  .pipe(new StringOutputParser())
  .pipe(wordCounter);

const result = await chain.invoke({
  language: "英文",
  text: "今天天气真好",
});
// { text: "The weather is really nice today.", wordCount: 7, charCount: 33 }
```

支持异步函数：

```typescript
const enricher = RunnableLambda.from(async (data: { query: string }) => {
  const context = await fetchFromDB(data.query);
  return { ...data, context };
});
```

`.pipe()` 里也可以直接传函数，框架会自动包成 Lambda：

```typescript
const chain = prompt
  .pipe(model)
  .pipe(new StringOutputParser())
  .pipe((text) => text.toUpperCase());
```

简洁，但失去显式命名。复杂链路里我建议都用 `RunnableLambda.from(fn)`，调试时 LangSmith 上能看到函数名。

## 4. RunnableParallel：分叉并行

输入一份，多个 Runnable 各跑各的，结果合成对象：

```typescript
import { RunnableParallel } from "@langchain/core/runnables";

// RunnableParallel.from({...}) 等价于 new RunnableParallel({ steps: {...} })
// 本书统一用 .from() 静态方法，更简洁。
const analyzeArticle = RunnableParallel.from({
  summary: summarizeChain,
  keywords: keywordChain,
  sentiment: sentimentChain,
});

const result = await analyzeArticle.invoke({ text: articleContent });
// {
//   summary: "...",
//   keywords: ["...", "..."],
//   sentiment: "positive"
// }
```

三条链并发执行（受底层 Provider 限流约束）。总耗时约等于最慢那条链的耗时，比顺序跑省一大截。

## 5. RunnablePassthrough：透传与字段拼装

`RunnablePassthrough` 把输入原样吐出来，常和 `RunnableParallel` 配合保留原始输入：

```typescript
import {
  RunnablePassthrough,
  RunnableParallel,
} from "@langchain/core/runnables";

const chain = RunnableParallel.from({
  question: new RunnablePassthrough(),          // 原始问题透传
  answer: qaPrompt.pipe(model).pipe(new StringOutputParser()),
});

const result = await chain.invoke("什么是 LCEL？");
// { question: "什么是 LCEL？", answer: "LCEL 是 ..." }
```

`RunnablePassthrough.assign()` 更常用：**保留所有输入字段、追加新字段**：

```typescript
// 输入：{ question: "...", context: "..." }
// 输出：{ question: "...", context: "...", answer: "..." }
const chain = RunnablePassthrough.assign({
  answer: async (input) => {
    const res = await model.invoke([
      { role: "user", content: `${input.context}\n\n问题：${input.question}` },
    ]);
    return res.text;
  },
});
```

这种模式在 RAG 里随处可见——检索回来的 `context` 不能丢，要拼到下游 prompt 里。

## 6. 三种调用方式

LCEL 链自动继承了 Runnable 的全部调用方式。

`invoke`：

```typescript
const result = await chain.invoke({ text: "你好" });
```

`batch`：

```typescript
const results = await chain.batch(
  [{ text: "你好" }, { text: "今天天气真好" }, { text: "AI 改变世界" }],
  { maxConcurrency: 3 }
);
```

`stream`：

```typescript
const stream = await chain.stream({ text: "请写一段关于 AI 的短文" });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

流式输出对用户体验很重要——前端用户能看到字一个个蹦出来，而不是干等几秒后突然砸下来一大段。

`streamEvents` 是更细粒度的版本，适合调试和监控，详见 [Runnable 接口详解](./runnable-interface.md)。

## 7. 类型推导

LCEL 在 TypeScript 下的类型推导是它最被低估的优点：

```typescript
// chain 自动推为 Runnable<{ language: string; text: string }, string>
const chain = prompt.pipe(model).pipe(new StringOutputParser());

// 缺字段 → 编译错
await chain.invoke({ text: "你好" });

// 类型对不上 → 编译错
chain.pipe((input: number) => input * 2);
```

我在生产里靠这套类型系统抓出过无数次"忘记传字段"和"上一段输出和下一段输入对不上"的低级错误。

## 8. 运行时配置：context 与 withConfig

LCEL 链调用时可以传 `RunnableConfig`：

```typescript
const result = await chain.invoke(
  { text: "你好" },
  {
    tags: ["prod"],
    metadata: { userId: "u-123" },
    context: { tier: "pro" },     // 运行时上下文
    runName: "TranslateChain",
  }
);
```

`context` 是承担"调用时传给链/Agent 的外部参数"这件事的标准字段。`RunnableLambda` 里能从 config 拿到：

```typescript
const lambda = RunnableLambda.from((input: string, config) => {
  const tier = (config?.context as { tier?: string } | undefined)?.tier;
  return `[${tier ?? "free"}] ${input}`;
});
```

固定配置可以用 `.withConfig()` 黏到链上，调用时不用再传：

```typescript
const taggedChain = chain.withConfig({
  tags: ["prod"],
  metadata: { component: "qa" },
});
```

## 9. 综合示例：翻译 + 分析的并行管线

把上面所有件拼一个能跑的实战示例：

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableLambda,
  RunnablePassthrough,
  RunnableParallel,
} from "@langchain/core/runnables";
import { z } from "zod";

const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });

// 1. 翻译子链
const translatePrompt = ChatPromptTemplate.fromMessages([
  ["system", "将用户输入翻译为 {language}，只输出译文。"],
  ["human", "{text}"],
]);
const translateChain = translatePrompt.pipe(model).pipe(new StringOutputParser());

// 2. 结构化分析子链（withStructuredOutput 在 Output Parsers 一节会讲）
const analysisSchema = z.object({
  topics: z.array(z.string()).describe("主题标签"),
  difficulty: z.enum(["easy", "medium", "hard"]).describe("难度"),
});

const analysisChain = ChatPromptTemplate.fromMessages([
  ["system", "分析文本的主题和难度。"],
  ["human", "{text}"],
]).pipe(model.withStructuredOutput(analysisSchema, { strategy: "tool" }));

// 3. 并行：同时翻译两种语言 + 分析 + 透传原文
// RunnableParallel.from(...)（等价于 new RunnableParallel({ steps: ... }) 构造）
// 会把同一个输入对象广播给每个分支：english/japanese 分支需要 language 字段，
// 所以用 assign 加上；analysis 分支只需要 text，原始输入已经满足，不需要再 assign。
const combined = RunnableParallel.from({
  english: RunnablePassthrough.assign({ language: () => "English" }).pipe(translateChain),
  japanese: RunnablePassthrough.assign({ language: () => "Japanese" }).pipe(translateChain),
  analysis: analysisChain,
  original: RunnableLambda.from((input: { text: string }) => input.text),
});

// 4. 格式化输出
const formatOutput = RunnableLambda.from(
  (input: {
    english: string;
    japanese: string;
    analysis: z.infer<typeof analysisSchema>;
    original: string;
  }) =>
    [
      `原文: ${input.original}`,
      `英文: ${input.english}`,
      `日文: ${input.japanese}`,
      `主题: ${input.analysis.topics.join(", ")}`,
      `难度: ${input.analysis.difficulty}`,
    ].join("\n")
);

const fullChain = combined.pipe(formatOutput);

const result = await fullChain.invoke({
  text: "大语言模型通过自注意力机制捕获序列中的长距离依赖关系。",
});

console.log(result);
// 原文: 大语言模型通过自注意力机制捕获序列中的长距离依赖关系。
// 英文: Large language models capture long-range dependencies in sequences via self-attention.
// 日文: 大規模言語モデルは自己注意機構を通じてシーケンス内の長距離依存関係を捕捉します。
// 主题: LLM, Self-Attention, Deep Learning
// 难度: hard
```

12 行配置 + 一个 `invoke`，跑出三件事：双语翻译、主题分析、原文回填。换成手工编排，并发控制、错误传播、类型对齐都要自己写。

## 10. 什么时候不要用 LCEL

LCEL 适合 DAG，不适合循环。Agent 的"思考-工具-观察-再思考"是循环，硬塞 LCEL 会很扭曲。

判断原则：

- **数据从入口一路流到出口、中间可分叉合并** → LCEL
- **需要循环、条件回跳、共享状态、并发分支带 join** → LangGraph

`createAgent` 内部就是用 LangGraph 实现的循环。详见 [createAgent 入门](../05-agent-architecture/create-agent.md)。

## 小结

| 工具 | 干什么 |
|------|--------|
| `.pipe()` | 串联两个 Runnable，类型自动对接 |
| `RunnableSequence.from` | `.pipe` 的显式形态，链长时更清晰 |
| `RunnableLambda.from` | 把函数包成 Runnable，能拿到 config |
| `RunnableParallel.from` | 分叉并行，多结果合成对象 |
| `RunnablePassthrough` | 透传输入；`.assign()` 追加字段 |
| `invoke / batch / stream` | 三种调用方式都自动继承 |
| TypeScript 类型推导 | 编译期发现接口对不上 |

下一节进入 [Model I/O](./model-io.md)，看 LCEL 的核心节点——Chat Model 是怎么工作的。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
