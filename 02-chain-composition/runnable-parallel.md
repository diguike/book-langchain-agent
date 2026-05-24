---
title: RunnableParallel
feishu_url: ""
last_synced: ""
---

> 模块 02 - Chain 组合 | 前置知识：[RunnableSequence](./runnable-sequence.md)

## 一个真实场景

我做内容平台时遇到的需求：每篇用户发的帖子需要同时跑三件事——摘要、关键词、情感分析。串行实现要 3 次 LLM 等待，10 万篇 / 天的话光是等模型就把吞吐压死了。

三步之间没有任何依赖关系，完全可以并发。`RunnableParallel` 就是 LCEL 里干这件事的原语：同一个输入广播给多个分支，所有分支并发跑，最后把结果按 key 合成一个对象返回。

## 两种构造方式

```typescript
import { RunnableParallel } from "@langchain/core/runnables";

// 写法 1：构造函数
const parallel = new RunnableParallel({
  summary: summaryChain,
  keywords: keywordsChain,
  sentiment: sentimentChain,
});

// 写法 2：直接传对象给 .pipe()，会自动包装成 RunnableParallel
const chain = prompt.pipe({
  summary: summaryChain,
  keywords: keywordsChain,
  sentiment: sentimentChain,
});
```

我的习惯：独立的并行节点用 `new RunnableParallel(...)`，作为链的一环时直接用对象字面量。

调用语义：

```typescript
const result = await parallel.invoke({ text: "今天天气真好" });
// 类型：{ summary: string; keywords: string[]; sentiment: SentimentResult }
```

**所有分支接收同一个输入，并发执行，结果合并成一个对象。** 这就是 RunnableParallel 的全部语义。

## 和 `RunnablePassthrough.assign()` 的差别

初学最容易搞混的就是这两个，它们都能产出多字段对象，差别在于"要不要保留原始输入"：

| 维度 | `RunnableParallel` | `RunnablePassthrough.assign()` |
|------|--------------------|--------------------------------|
| 原始输入 | 不保留，输出只含定义的字段 | 保留，并追加新字段 |
| 典型用途 | 从零构建输出对象 | 在已有数据上增量添加字段 |
| 链中位置 | 通常是终点或分叉点 | 通常在链中段做"数据增厚" |

直接对比看：

```typescript
import {
  RunnableParallel,
  RunnablePassthrough,
} from "@langchain/core/runnables";

// RunnableParallel：原始的 x 字段被丢掉
const p1 = new RunnableParallel({
  a: (input: { x: number }) => input.x + 1,
  b: (input: { x: number }) => input.x * 2,
});
await p1.invoke({ x: 5 });
// => { a: 6, b: 10 }

// RunnablePassthrough.assign：x 还在
const p2 = RunnablePassthrough.assign({
  a: (input: { x: number }) => input.x + 1,
  b: (input: { x: number }) => input.x * 2,
});
await p2.invoke({ x: 5 });
// => { x: 5, a: 6, b: 10 }
```

经验法则：链中段需要把上游数据继续往下传，用 `assign`；只关心几个分支的产出本身，用 `RunnableParallel`。

## 合并策略：默认浅合并，需要自定义就接 lambda

RunnableParallel 自身的合并逻辑很简单：每个分支的输出放到对应 key 下。需要 reshape 就在后面接一个 lambda：

```typescript
const enriched = new RunnableParallel({
  summary: summaryChain,
  keywords: keywordsChain,
}).pipe((results) => ({
  report: `摘要：${results.summary}\n关键词：${results.keywords.join("、")}`,
  metadata: {
    summaryLength: results.summary.length,
    keywordCount: results.keywords.length,
  },
}));
```

## 错误处理：默认是 Promise.all 语义

任何一个分支抛异常，整个 parallel 失败，其他分支已经算出来的结果会被丢弃：

```typescript
const risky = new RunnableParallel({
  safe: () => "ok",
  bad: () => {
    throw new Error("boom");
  },
});

try {
  await risky.invoke({});
} catch (e) {
  console.error((e as Error).message); // "boom"
  // safe 的 "ok" 也拿不到
}
```

要让某个分支失败不影响整体，给它单独挂 fallback：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const riskyBranch = new RunnableLambda({
  func: async () => fetchExternalAPI(),
}).withFallbacks([
  // 失败时返回降级结果而不是抛异常
  new RunnableLambda({ func: () => ({ error: "数据源暂不可用" }) }),
]);

const resilient = new RunnableParallel({
  safe: safeChain,
  risky: riskyBranch,
});
```

`.withFallbacks([...])` 的细节在 [Fallback 与重试](./fallback-retry.md) 里展开。

## 完整示例：摘要 + 关键词 + 情感分析

把开头那个真实场景写完整。三个分支并发跑，最后用 `assign` 把分析结果挂回原始文本上：

```typescript
// content-analysis.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { z } from "zod";

// 短任务用速度档：Haiku 4.5 / GPT-4o-mini 都行
const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const stringParser = new StringOutputParser();

// 分支 1：摘要
const summaryChain = ChatPromptTemplate.fromTemplate(
  "用 2-3 句话概括以下文本的核心内容：\n\n{text}",
)
  .pipe(model)
  .pipe(stringParser);

// 分支 2：关键词（结构化输出，比 prompt 里写 JSON 格式稳得多）
const keywordsSchema = z.object({
  keywords: z.array(z.string()).length(5),
});
const keywordsChain = ChatPromptTemplate.fromTemplate(
  "从以下文本中提取 5 个最重要的关键词：\n\n{text}",
)
  .pipe(model.withStructuredOutput(keywordsSchema, { strategy: "tool" }))
  .pipe((r) => r.keywords);

// 分支 3：情感分析
const sentimentSchema = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
const sentimentChain = ChatPromptTemplate.fromTemplate(
  "分析以下文本的情感倾向：\n\n{text}",
)
  .pipe(model.withStructuredOutput(sentimentSchema, { strategy: "tool" }));

// 主链：用 assign 让三个分支并行执行，并把结果挂在原始输入旁边
const analysisChain = RunnablePassthrough.assign({
  summary: summaryChain,
  keywords: keywordsChain,
  sentiment: sentimentChain,
});

const result = await analysisChain.invoke({
  text: `
    苹果今天发布了全新的 Vision Pro 2 头显。新设备比前代减重 40%，电池续航
    提升到 4 小时。不过 4999 美元的售价仍让许多消费者望而却步。
  `,
});

console.log(JSON.stringify(result, null, 2));
// {
//   "text": "苹果今天发布了...",     // 原始输入保留
//   "summary": "苹果发布 Vision Pro 2，减重提升续航但定价过高",
//   "keywords": ["Vision Pro 2", "苹果", "续航", "售价", "空间计算"],
//   "sentiment": {
//     "sentiment": "neutral",
//     "confidence": 0.7,
//     "reason": "同时包含正面（性能提升）和负面（价格高昂）信息"
//   }
// }
```

实测下来，三个分支并发执行的总耗时差不多等于最慢那个分支的耗时，对比串行版本能省 60% 的时间。

## 实战：多数据源聚合查询

知识问答场景里我经常要从多个数据源同时取信息：向量库、Web 搜索、数据库。这是 `RunnableParallel` 的另一个典型用法。

```typescript
// multi-source-rag.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableLambda,
  RunnableParallel,
  RunnablePassthrough,
} from "@langchain/core/runnables";

const model = new ChatOpenAI({ model: "gpt-4o" });
const parser = new StringOutputParser();

// 三个独立的数据源（生产环境替换成真实实现）
const searchDocs = new RunnableLambda({
  func: async (query: string) => [`[Docs] 关于 ${query} 的文档片段...`],
});

const searchWeb = new RunnableLambda({
  func: async (query: string) => [`[Web] 关于 ${query} 的最新信息...`],
});

const searchDB = new RunnableLambda({
  func: async (query: string) => [`[DB] ${query} 相关的结构化数据...`],
});

// 三路并发检索
const multiSourceSearch = new RunnableParallel({
  docs: searchDocs,
  web: searchWeb,
  db: searchDB,
});

// 主链：检索 → 合并上下文 → 生成回答
const qaChain = RunnablePassthrough.assign({
  sources: (input: { question: string }) =>
    multiSourceSearch.invoke(input.question),
})
  .pipe((input) => ({
    question: input.question,
    context: [...input.sources.docs, ...input.sources.web, ...input.sources.db]
      .join("\n"),
  }))
  .pipe(
    ChatPromptTemplate.fromTemplate(
      `基于以下信息回答用户问题。

参考信息：
{context}

用户问题：{question}

请给出准确、全面的回答：`,
    ),
  )
  .pipe(model)
  .pipe(parser);

const answer = await qaChain.invoke({ question: "LangChain 是什么？" });
console.log(answer);
```

## 并发数控制

`RunnableParallel` 默认让所有分支同时启动，不做限流。分支多到几十个、每个又都调外部 API 时，得自己控制。最简单的办法是用 `p-limit`：

```typescript
import pLimit from "p-limit";
import { RunnableLambda, RunnableParallel } from "@langchain/core/runnables";

const limit = pLimit(3); // 最多 3 个并发

const controlled = new RunnableParallel({
  a: new RunnableLambda({ func: (i) => limit(() => chainA.invoke(i)) }),
  b: new RunnableLambda({ func: (i) => limit(() => chainB.invoke(i)) }),
  c: new RunnableLambda({ func: (i) => limit(() => chainC.invoke(i)) }),
  d: new RunnableLambda({ func: (i) => limit(() => chainD.invoke(i)) }),
});
```

`batch()` 的外层也有并发控制，两层并发会叠乘：

```typescript
// 10 条文本各跑一次分析，每条内部 3 个并发分支
// 理论峰值并发 = 10 × 3 = 30 次 LLM 调用
await analysisChain.batch(tenTexts, { maxConcurrency: 5 });
// 外层限到 5，所以实际峰值 = 5 × 3 = 15
```

## 小结

| 项 | 说明 |
|----|------|
| 构造 | `new RunnableParallel({...})` 或 `.pipe({...})` |
| 执行 | 所有分支接收同一输入，并发跑 |
| 输出 | 合并为对象，key 即分支名 |
| 错误 | Promise.all 语义，任一分支失败则整体失败 |
| 容错 | 单分支挂 `.withFallbacks([...])` 即可独立容错 |
| 并发控制 | 自己用 `p-limit` 限；batch 层用 `maxConcurrency` |

下一节我讲 [RunnableBranch](./runnable-branch.md)——根据输入条件动态选一个分支跑，而不是全跑。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
