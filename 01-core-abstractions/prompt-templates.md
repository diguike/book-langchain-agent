---
title: Prompt Templates
feishu_url: ""
last_synced: ""
---

> 模块 01 - 核心抽象 | 前置：[Model I/O](./model-io.md)

Prompt Template 解决一件事：把字符串拼接代码变成可复用、可组合、类型安全的对象。

这一节我把 `ChatPromptTemplate` 的常用模式过一遍，包括变量注入、消息角色、`MessagesPlaceholder` 动态消息插槽、`partial` 预绑定。最后给一个支持多轮对话和 Few-shot 示例的完整模板。

## 1. 为什么需要 Prompt Template

先看反模式——手工拼接：

```typescript
// 别这么写
const prompt = `你是${role}，请基于以下上下文回答：\n${context}\n\n问题：${question}`;
```

问题挺明显：

- 复用差，每次都要重写拼接逻辑
- 没法验证缺失变量
- 接不进 LCEL，没法享受类型推导、流式、批量、可观测
- 没法区分 System / Human / AI 消息

`ChatPromptTemplate` 一次性解决这些。

## 2. ChatPromptTemplate：从消息列表构建

最常见的形态是 `fromMessages` + 元组数组：

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是 {domain} 领域的专家，用 {style} 的风格回答。"],
  ["human", "{question}"],
]);

const messages = await prompt.formatMessages({
  domain: "人工智能",
  style: "简洁",
  question: "什么是 Transformer？",
});

console.log(messages);
// [
//   SystemMessage { content: "你是 人工智能 领域的专家，用 简洁 的风格回答。" },
//   HumanMessage  { content: "什么是 Transformer？" },
// ]
```

元组第一项是角色，对应 LangChain.js 的消息类：

| 角色 | 对应类 | 含义 |
|------|--------|------|
| `"system"` | `SystemMessage` | 系统指令，定义 AI 行为 |
| `"human"` 或 `"user"` | `HumanMessage` | 用户输入 |
| `"ai"` 或 `"assistant"` | `AIMessage` | AI 回复（Few-shot 时用） |
| `"placeholder"` | `MessagesPlaceholder` | 动态消息插槽 |

也可以直接传消息实例：

```typescript
import { SystemMessage } from "@langchain/core/messages";

const prompt = ChatPromptTemplate.fromMessages([
  new SystemMessage("你是翻译助手。"),
  ["human", "把以下内容翻译为 {language}：\n{text}"],
]);
```

## 3. 变量注入

模板用 `{variableName}` 标记变量：

```typescript
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是 {name}，专长是 {expertise}。"],
  ["human", "{question}"],
]);

console.log(prompt.inputVariables);
// ["name", "expertise", "question"]

const messages = await prompt.formatMessages({
  name: "小明",
  expertise: "全栈开发",
  question: "如何优化 React 性能？",
});
```

少传变量会抛错。这是好事——线上反馈"模板渲染出空字符串"远比"运行时直接报错"难定位。

### 字面量花括号

如果模板里要出现字面量 `{`，用双花括号转义：

```typescript
const prompt = ChatPromptTemplate.fromMessages([
  ["system", '请输出 JSON 格式，示例：{{"key": "value"}}'],
  ["human", "{question}"],
]);
```

## 4. Few-shot 示例

把示例当成 Human/AI 交替的消息塞进模板：

```typescript
const fewShotPrompt = ChatPromptTemplate.fromMessages([
  ["system", "你是情感分类助手，输出 正面 / 负面 / 中性 之一。"],
  // 示例 1
  ["human", "这部电影太棒了，看了三遍。"],
  ["ai", "正面"],
  // 示例 2
  ["human", "服务态度太差了，再也不来了。"],
  ["ai", "负面"],
  // 实际输入
  ["human", "{text}"],
]);

const messages = await fewShotPrompt.formatMessages({
  text: "味道还行，但是等了太久。",
});
```

模型看到的就是一段"已经在分类"的对话，会自然延续下去。这套模式对小模型尤其有效。

## 5. MessagesPlaceholder：动态消息插槽

`MessagesPlaceholder` 在模板里挖一个洞，运行时填入任意数量的消息。对话历史、Agent 中间消息都靠它：

```typescript
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是有记忆的对话助手。"],
  new MessagesPlaceholder("history"),
  ["human", "{input}"],
]);

const messages = await prompt.formatMessages({
  history: [
    new HumanMessage("你好"),
    new AIMessage("你好，有什么可以帮你？"),
    new HumanMessage("我叫小明"),
    new AIMessage("你好小明，很高兴认识你。"),
  ],
  input: "你还记得我叫什么吗？",
});
```

元组语法的简写：

```typescript
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是有记忆的对话助手。"],
  ["placeholder", "{history}"],      // 等价于 MessagesPlaceholder("history")
  ["human", "{input}"],
]);
```

### 可选 placeholder

默认情况下 `history` 没传会抛错。设为可选：

```typescript
new MessagesPlaceholder({ variableName: "history", optional: true });
```

## 6. PromptTemplate：纯字符串模板

`PromptTemplate` 输出 string 而不是消息列表，主要用在不需要角色区分的子模板里：

```typescript
import { PromptTemplate } from "@langchain/core/prompts";

const sub = PromptTemplate.fromTemplate(
  "已检索到的上下文：\n{context}\n\n问题：{question}"
);

const text = await sub.format({
  context: "LangChain.js 是一个 LLM 应用框架。",
  question: "LangChain.js 是什么？",
});
```

实际项目里我极少在顶层用 `PromptTemplate`，它的位置一般是作为 `ChatPromptTemplate` 内部某条消息的"内容模板"。顶层始终用 `ChatPromptTemplate`。

## 7. partial：预绑定变量

某些变量在模板创建时就已知（当前日期、租户 ID 等），用 `partial` 预绑定：

```typescript
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "当前日期：{date}\n你是 {role}。"],
  ["human", "{question}"],
]);

// 方式 1：静态值
const partialPrompt = await prompt.partial({
  date: new Date().toISOString().split("T")[0],
});

// 调用时只需提供剩余变量
const messages = await partialPrompt.formatMessages({
  role: "AI 助手",
  question: "今天星期几？",
});

// 方式 2：动态函数（每次 format 时重新计算）
const dynamicPrompt = await prompt.partial({
  date: () => new Date().toISOString().split("T")[0],
});
```

动态 `partial` 在"注入当前时间""注入 session ID"这类场景里很方便，比每次手动 spread 一份输入对象干净。

## 8. 与 LCEL 配合

Prompt Template 是 Runnable，输入是 `Record<string, unknown>`，输出是消息列表，可以直接 `.pipe()` 接模型：

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

const chain = prompt
  .pipe(new ChatOpenAI({ model: "gpt-4o-mini" }))
  .pipe(new StringOutputParser());

const answer = await chain.invoke({
  role: "技术顾问",
  question: "如何理解 Vector Search？",
});
```

## 9. 综合示例：完整的对话模板

把上面所有特性拼一个能跑的完整链——支持系统指令、Few-shot 示例、对话历史、动态日期：

```typescript
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

// 1. 模板定义
const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是 {domain} 领域的技术顾问。
回答风格：
- 先给出简短结论
- 再展开详细解释
- 最后给出实践建议

当前日期：{date}`,
  ],
  // Few-shot 示例（可选）
  ["placeholder", "{examples}"],
  // 历史对话
  ["placeholder", "{history}"],
  // 当前输入
  ["human", "{input}"],
]);

// 2. 预绑定静态/动态变量
const boundPrompt = await prompt.partial({
  date: () => new Date().toLocaleDateString("zh-CN"),
  domain: "云原生",
});

// 3. 组成完整链
const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
const chain = boundPrompt.pipe(model).pipe(new StringOutputParser());

// 4. 调用
const answer = await chain.invoke({
  examples: [
    new HumanMessage("Kubernetes 和 Docker 有什么区别？"),
    new AIMessage(
      "结论：Docker 是容器运行时，Kubernetes 是容器编排平台。\n\n详细解释：Docker 负责创建和运行单个容器...\n\n实践建议：先掌握 Docker 基础，再上手 Kubernetes。"
    ),
  ],
  history: [
    new HumanMessage("我想学习微服务架构"),
    new AIMessage("微服务是现代后端的主流模式之一..."),
  ],
  input: "微服务之间如何通信？",
});

console.log(answer);
```

### 模板集中管理

实际项目里我会把模板都放一个文件，便于版本管理和审阅：

```typescript
// src/prompts.ts
import { ChatPromptTemplate } from "@langchain/core/prompts";

export const TRANSLATE_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", "你是专业翻译，目标语言：{targetLang}。保持原文格式。"],
  ["human", "{text}"],
]);

export const SUMMARIZE_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", "你是摘要助手，请用不超过 {maxWords} 字概括以下内容。"],
  ["human", "{article}"],
]);

export const CHAT_PROMPT = ChatPromptTemplate.fromMessages([
  ["system", "{systemPrompt}"],
  ["placeholder", "{history}"],
  ["human", "{input}"],
]);
```

```typescript
// 使用
import { TRANSLATE_PROMPT } from "./prompts";

const translateChain = TRANSLATE_PROMPT
  .pipe(model)
  .pipe(new StringOutputParser());

await translateChain.invoke({
  targetLang: "日文",
  text: "人工智能正在改变世界。",
});
```

## 10. Agent 场景的特殊情况

在 [createAgent 入门](../05-agent-architecture/create-agent.md) 一节你会看到 Agent 的 `systemPrompt` 直接传字符串，不走 `ChatPromptTemplate`：

```typescript
const agent = createAgent({
  model,
  tools,
  systemPrompt: "你是简洁的助手...",
});
```

需要动态 system prompt（按用户 tier 切换内容）时也不在外层做模板渲染，而是用 `dynamicSystemPromptMiddleware` 拿到运行时的 `state` 和 `context` 来生成。详见 [Middleware 系统](../05-agent-architecture/middleware.md)。

也就是说：

- **LCEL 链** → 用 `ChatPromptTemplate` 组合 prompt
- **Agent** → 直接传字符串，需要动态时走 middleware

## 小结

| 概念 | 要点 |
|------|------|
| `ChatPromptTemplate` | 顶层首选，输出消息列表 |
| 角色 | system / human / ai / placeholder |
| 变量 | `{name}` 语法，双花括号转义字面量 |
| `MessagesPlaceholder` | 动态插入消息列表，对话历史必备 |
| `partial` | 预绑定已知变量，支持动态函数 |
| `PromptTemplate` | 纯字符串模板，仅作为子模板 |
| Agent 场景 | 直接传 string，动态时走 middleware |

下一节进入 [Output Parsers](./output-parsers.md)，看怎么把模型输出从自由文本变成结构化数据。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
