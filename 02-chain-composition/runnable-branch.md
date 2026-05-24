---
title: RunnableBranch
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/G8eOwXQDAifbhOkofbRc6xtQnKf"
last_synced: "2026-05-25T02:41:07+08:00"
---

> 模块 02 - Chain 组合 | 前置知识：[RunnableSequence](./runnable-sequence.md)、[RunnableParallel](./runnable-parallel.md)

## Sequence 和 Parallel 之外的第三种组合

到目前为止学到的链都是"无脑跑到底"——不论输入是什么，每一步都执行。但真实应用里几乎总有分支：

- 用户说中文 → 用中文链；说英文 → 用英文链
- 输入很短 → 直接生成；输入很长 → 先摘要再生成
- 用户是付费用户 → 用强模型；免费用户 → 用便宜模型

`RunnableBranch` 就是 LCEL 里写 if-else 的标准方式。它接收一组 `[条件, 分支]` 对再加一个默认分支，跑的时候**只挑第一个命中的分支执行**——这是它和 `RunnableParallel` 的根本差别。

## 基本用法

```typescript
import { RunnableBranch } from "@langchain/core/runnables";

const branch = RunnableBranch.from([
  // [条件 1, 处理链 1]
  [(input) => input.type === "question", questionChain],
  // [条件 2, 处理链 2]
  [(input) => input.type === "command", commandChain],
  // 默认分支（位置在最后，无条件）
  defaultChain,
]);
```

执行规则：

1. 依次评估每个条件
2. 第一个返回 `true` 的，对应分支执行，后面的条件不再评估
3. 全部不命中，跑默认分支
4. **永远只跑一个分支**

条件函数支持 async：

```typescript
const branch = RunnableBranch.from([
  [
    async (input: { userId: string }) => {
      const user = await db.getUser(input.userId);
      return user.isPremium;
    },
    premiumChain,
  ],
  freeChain,
]);
```

异步条件很有用——比如查一下用户是不是付费用户再决定走哪条链。但每多一次异步评估就多一次延迟，写多条异步条件时要意识到这是顺序求值的，不是并发的。

## 默认分支是必填的

`RunnableBranch.from()` 强制你给一个默认分支。这个设计很好——它逼着你想清楚"所有条件都不匹配时该怎么办"，避免运行时挂掉。

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

// 三种常见的默认分支写法
const defaultBranch1 = new RunnableLambda({
  func: (input) => `无法处理此类输入：${JSON.stringify(input)}`,
});

const defaultBranch2 = new RunnableLambda({ func: (input) => input }); // 透传

const defaultBranch3 = genericProcessingChain; // 通用兜底链
```

## 复杂场景：RunnableBranch vs RunnableLambda

`RunnableBranch` 适合"少量、扁平、声明式"的分支。一旦分支数超过 5 个、或者路由逻辑需要查表 / 调 LLM 做意图分类，我会改用 `RunnableLambda`：

```typescript
import { RunnableLambda } from "@langchain/core/runnables";

const router = new RunnableLambda({
  func: async (input: { type: string; data: string }) => {
    switch (input.type) {
      case "translate":
        return translateChain.invoke(input);
      case "summarize":
        return summarizeChain.invoke(input);
      case "analyze":
        return analyzeChain.invoke(input);
      default:
        return `不支持的操作类型：${input.type}`;
    }
  },
});
```

什么时候选哪个：

| 场景 | 推荐 | 理由 |
|------|------|------|
| 2-4 个分支，条件简单 | `RunnableBranch` | 声明式，trace 更清晰 |
| 5+ 分支或查表路由 | `RunnableLambda` + Map | 维护性好 |
| 需要 LLM 做分类决策 | `RunnableLambda`（内部嵌 LCEL） | 灵活 |
| 嵌套超过两层 | 都不推荐，改 LangGraph | 控制流复杂到这种程度就该用图 |

最后一点很重要：`02-Chain 组合` 这一模块讲的所有原语都是**无状态的流水线**。一旦你发现自己想要"循环"、"回滚"、"分支汇合到同一个状态"，那就是 LangGraph 的活儿，不该硬塞进 LCEL。详细的取舍标准看 [LCEL vs LangGraph 决策指南](./lcel-vs-langgraph.md)。

## 完整示例：意图识别 + 路由

把"用 LLM 做分类 → 按分类结果路由"的完整链拼起来。这是客服 / 助手类产品里最常见的模式。

```typescript
// intent-router.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableBranch,
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";

// 分类用速度档（Haiku 4.5 / GPT-4o-mini），各处理链可以用更强的模型
const classifier = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
const responder = new ChatOpenAI({ model: "gpt-4o", temperature: 0.3 });
const parser = new StringOutputParser();

// 意图分类子链
const classifyIntent = ChatPromptTemplate.fromTemplate(
  `将以下用户消息分类为：question / complaint / feedback / other。
只返回意图名称，不要其他内容。

用户消息：{message}`,
)
  .pipe(classifier)
  .pipe(parser)
  .pipe((intent: string) => intent.trim().toLowerCase());

// 四条处理链
const questionChain = ChatPromptTemplate.fromTemplate(
  "用户提出了一个问题，请专业、详细地回答：\n{message}",
)
  .pipe(responder)
  .pipe(parser);

const complaintChain = ChatPromptTemplate.fromTemplate(
  "用户提出了投诉，请先表达歉意和理解，再提供解决方案：\n{message}",
)
  .pipe(responder)
  .pipe(parser);

const feedbackChain = ChatPromptTemplate.fromTemplate(
  "用户提供了反馈，请表达感谢并说明我们会如何处理：\n{message}",
)
  .pipe(responder)
  .pipe(parser);

const otherChain = ChatPromptTemplate.fromTemplate(
  "请友好地回应用户：\n{message}",
)
  .pipe(responder)
  .pipe(parser);

// 主链：分类 + 路由
const routerChain = RunnableSequence.from([
  // 第一步：保留原始输入，同时附加 intent 字段
  RunnablePassthrough.assign({
    intent: (input: { message: string }) =>
      classifyIntent.invoke({ message: input.message }),
  }),
  // 第二步：按 intent 路由
  RunnableBranch.from([
    [(input: { message: string; intent: string }) => input.intent === "question", questionChain],
    [(input) => input.intent === "complaint", complaintChain],
    [(input) => input.intent === "feedback", feedbackChain],
    otherChain,
  ]),
]);

// 测试
const responses = await Promise.all([
  routerChain.invoke({ message: "你们的 API 响应时间为什么这么慢？" }),
  routerChain.invoke({ message: "LangChain 支持哪些向量数据库？" }),
  routerChain.invoke({ message: "建议增加对 Milvus 的原生支持" }),
]);
responses.forEach((r, i) => console.log(`#${i + 1}: ${r}\n`));
```

这条链值得细看的几个细节：

1. **分类器和回复器用不同的模型**——分类是简单任务，用 mini 模型省钱；回复要质量，用大模型。这种"小模型决策、大模型执行"的模式在生产里非常常见。
2. **`RunnablePassthrough.assign`** 让我把分类结果挂到原始输入上，路由分支既能拿到原文也能拿到分类标签。
3. **路由分支的输入类型**是合并后的 `{ message, intent }`，TypeScript 自动推断。

## 实战：根据语言路由到对应专属链

这是另一个典型场景——多语言 SaaS。我希望中文用户拿到地道中文回复，英文用户拿到 native English 风格，而不是"模型自己看着办"。

```typescript
// language-router.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableBranch,
  RunnableLambda,
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";

const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const parser = new StringOutputParser();

// 语言检测
const detectLanguage = new RunnableLambda({
  func: async (input: { text: string }) => {
    const lang = await ChatPromptTemplate.fromTemplate(
      "检测文本语言，只返回代码（zh / en / ja / ko / other）：\n{text}",
    )
      .pipe(model)
      .pipe(parser)
      .invoke({ text: input.text });
    return lang.trim().toLowerCase();
  },
});

// 各语言专属链：用对应母语写系统提示
const zhChain = ChatPromptTemplate.fromMessages([
  ["system", "你是一位中文助手。请用地道、自然的中文回答。"],
  ["human", "{text}"],
])
  .pipe(model)
  .pipe(parser);

const enChain = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful English assistant. Reply in clear, professional English."],
  ["human", "{text}"],
])
  .pipe(model)
  .pipe(parser);

const jaChain = ChatPromptTemplate.fromMessages([
  ["system", "あなたは日本語アシスタントです。丁寧で自然な日本語で答えてください。"],
  ["human", "{text}"],
])
  .pipe(model)
  .pipe(parser);

const koChain = ChatPromptTemplate.fromMessages([
  ["system", "당신은 한국어 어시스턴트입니다. 정중하고 자연스러운 한국어로 답변해 주세요."],
  ["human", "{text}"],
])
  .pipe(model)
  .pipe(parser);

const defaultLangChain = ChatPromptTemplate.fromTemplate(
  "用户使用了不支持的语言。请用中文和英文双语提示对方使用中、英、日、韩任一语言：\n{text}",
)
  .pipe(model)
  .pipe(parser);

// 组合
const multiLang = RunnableSequence.from([
  RunnablePassthrough.assign({ lang: detectLanguage }),
  RunnableBranch.from([
    [(input: { text: string; lang: string }) => input.lang === "zh", zhChain],
    [(input) => input.lang === "en", enChain],
    [(input) => input.lang === "ja", jaChain],
    [(input) => input.lang === "ko", koChain],
    defaultLangChain,
  ]),
]);

const results = await Promise.all([
  multiLang.invoke({ text: "如何学习编程？" }),
  multiLang.invoke({ text: "How to learn programming?" }),
  multiLang.invoke({ text: "プログラミングの学び方は？" }),
]);
results.forEach((r) => console.log(r, "\n"));
```

## 嵌套路由：能用但要克制

`RunnableBranch` 可以嵌套，写多级决策树：

```typescript
const nested = RunnableBranch.from([
  [
    (input) => input.category === "tech",
    RunnableBranch.from([
      [(input) => input.subcategory === "frontend", frontendChain],
      [(input) => input.subcategory === "backend", backendChain],
      generalTechChain,
    ]),
  ],
  [(input) => input.category === "business", businessChain],
  defaultChain,
]);
```

但**嵌套超过 2 层我就不写 RunnableBranch 了**。可读性断崖式下跌，trace 里展开一团乱。两层以上我改用 Map 查表：

```typescript
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";

const chainRegistry = new Map<string, Runnable>([
  ["tech.frontend", frontendChain],
  ["tech.backend", backendChain],
  ["tech.default", generalTechChain],
  ["business", businessChain],
]);

const lookupRouter = new RunnableLambda({
  func: async (input: { category: string; subcategory?: string }) => {
    const key = input.subcategory
      ? `${input.category}.${input.subcategory}`
      : input.category;
    const chain =
      chainRegistry.get(key) ??
      chainRegistry.get(`${input.category}.default`) ??
      defaultChain;
    return chain.invoke(input);
  },
});
```

## 调试技巧：给分支命名

LangSmith trace 里 `RunnableBranch` 会显示"命中了第几条分支"。给每个分支起个名字，调试效率高很多：

```typescript
const branch = RunnableBranch.from([
  [isQuestion, questionChain.withConfig({ runName: "QuestionHandler" })],
  [isComplaint, complaintChain.withConfig({ runName: "ComplaintHandler" })],
  otherChain.withConfig({ runName: "FallbackHandler" }),
]).withConfig({ runName: "IntentRouter" });
```

## 小结

| 项 | 说明 |
|----|------|
| 构造 | `RunnableBranch.from([[cond, chain], ..., default])` |
| 执行 | 第一个命中的分支执行，其余跳过 |
| 默认分支 | 必填，处理全部条件都不匹配的情况 |
| 异步条件 | 支持，但顺序求值，注意延迟 |
| 嵌套 | 支持，但超过 2 层就该换写法 |
| 替代方案 | 复杂场景用 `RunnableLambda + Map` 查表 |

下一节我讲 [Streaming 流式输出](./streaming.md)——怎么让用户在 200ms 就看到模型开始打字，而不是等 5 秒钟拿到完整文本。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
