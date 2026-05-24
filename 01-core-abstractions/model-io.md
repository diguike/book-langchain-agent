---
title: Model I/O
feishu_url: ""
last_synced: ""
---

> 模块 01 - 核心抽象 | 前置：[LCEL 表达式语言](./lcel.md)

Model I/O 讲的是怎么把模型抽象成一个 Runnable：输入消息、输出消息、能流式、能批量、能切 Provider。这一节我把 OpenAI、Anthropic、Ollama 三个常用 Provider 的接入过一遍，再讲消息体的 `contentBlocks` 结构、Embeddings 用法，最后给一个跨 Provider 切换的实战例子。

读完这节你会知道怎么选模型、怎么配置模型、怎么写一段对所有 Provider 都通用的调用代码。

## 1. Chat Model：唯一的模型抽象

LangChain.js 只有一种模型抽象：`BaseChatModel`。输入是消息列表 `BaseMessageLike[]`，输出是消息 `AIMessage`，没有第二种。

任何主流 Provider 现在都走 Chat 接口（OpenAI 的纯 completion 接口早不更新了，Anthropic 一开始就没有过纯 completion）。多角色对话、工具调用、多模态都需要消息这个结构。

接下来三个小节是三个 Provider 的接入，写得比较细，因为参数细节直接决定能不能跑通。

## 2. ChatOpenAI

安装：

```bash
npm install @langchain/openai
```

最小代码：

```typescript
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "gpt-4o-mini",        // 模型 ID，见下面选型表
  temperature: 0,              // 0 = 确定性输出，1 = 更发散
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await model.invoke([
  { role: "user", content: "用一句话解释 Vector Database" },
]);

console.log(response.text);
```

完整配置：

```typescript
const model = new ChatOpenAI({
  model: "gpt-5",
  temperature: 0,
  maxTokens: 4096,
  streaming: true,

  // 自定义 endpoint（走代理、Azure OpenAI 都用这个）
  configuration: {
    baseURL: "https://your-proxy.com/v1",
  },

  timeout: 60_000,      // 单次请求超时（毫秒）
  maxRetries: 2,        // SDK 层重试

  // GPT-5 系列推理参数
  reasoning: { effort: "medium" },   // "minimal" | "low" | "medium" | "high"
});
```

OpenAI 模型选型，按场景：

| 场景 | 模型 | 备注 |
|------|------|------|
| 复杂推理、规划 | `gpt-5` / `gpt-5.4` / `gpt-5.5` | 价格高，配合 `reasoning.effort` |
| 通用工作负载 | `gpt-4o` | 平衡性能成本 |
| 简单分类、低延迟 | `gpt-4o-mini` | 便宜，开发调试默认用它 |

## 3. ChatAnthropic

安装：

```bash
npm install @langchain/anthropic
```

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const claude = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  temperature: 0,
  maxTokens: 8192,                              // Anthropic 必填
  apiKey: process.env.ANTHROPIC_API_KEY,

  // Extended Thinking（深度推理模式）
  // thinking: { type: "enabled", budgetTokens: 10000 },
});
```

Anthropic 有两个坑要注意：

1. `maxTokens` 必填。不设置会被默认值截断输出，调试时表现为"模型说话说一半就没了"。
2. System Message 在内部会被提取到独立的 `system` 参数（不和其他消息混排）。LangChain.js 自动帮你处理，你只管按消息列表传。

Anthropic 模型选型：

| 场景 | 模型 | 备注 |
|------|------|------|
| 旗舰推理 | `claude-opus-4-7` | 复杂规划、长文本，最贵 |
| 平衡 | `claude-sonnet-4-6` | 大部分 Agent 默认选这个 |
| 速度 | `claude-haiku-4-5` | 路由、分类、简单工具调用 |

## 4. ChatOllama：本地模型

私有部署、离线开发、隐私敏感的场景用 [Ollama](https://ollama.com/)：

```bash
npm install @langchain/ollama
```

```typescript
import { ChatOllama } from "@langchain/ollama";

const local = new ChatOllama({
  model: "llama3.1",
  baseUrl: "http://localhost:11434",
  temperature: 0,
  numCtx: 4096,
  numPredict: 1024,
});
```

Ollama 的好处是开发期成本为零。我的常见用法是：调试链路用 Ollama 跑通，上线切到云端 Provider，因为接口完全一致，只换一行实例化。

## 5. 消息结构与 contentBlocks

输入和输出都是消息。1.x 用 `contentBlocks` 字段统一表达多模态内容：

```typescript
const response = await model.invoke([
  { role: "user", content: "你好" },
]);

// 纯文本场景，response.text 直接拿字符串
console.log(response.text);

// 一般情况下，response.contentBlocks 是统一格式
for (const block of response.contentBlocks) {
  if (block.type === "text") {
    console.log("文本:", block.text);
  } else if (block.type === "tool_use") {
    console.log("工具调用:", block.name, block.input);
  }
}
```

`contentBlocks` 的常见 `type`：

| type | 说明 |
|------|------|
| `text` | 纯文本片段 |
| `tool_use` | 模型发起的工具调用 |
| `tool_result` | 工具执行结果（输入侧消息中） |
| `image` | 多模态图像 |
| `thinking` | Anthropic Extended Thinking 的推理块 |

纯文本场景写代码用 `response.text` 最直接。涉及多模态、工具调用、推理过程展示时，一定要走 `contentBlocks`，因为 `response.text` 会丢掉非 text 块的信息。

多模态输入也是同样的格式：

```typescript
const visionModel = new ChatOpenAI({ model: "gpt-4o" });

const response = await visionModel.invoke([
  {
    role: "user",
    content: [
      { type: "text", text: "这张图里有什么？" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo..." },
      },
    ],
  },
]);
```

## 6. 流式输出

每个 Chat Model 都支持流式：

```typescript
const stream = await model.stream([
  { role: "user", content: "写一首关于编程的五言绝句" },
]);

for await (const chunk of stream) {
  // chunk 是 AIMessageChunk
  process.stdout.write(chunk.text);
}
```

`chunk.text` 是这次 chunk 累积的纯文本（属性 getter，把 contentBlocks 里的 text 块拼起来）。多模态流式场景请处理 `chunk.contentBlocks`。

## 7. Embeddings

Embeddings 把文本转向量。RAG (Retrieval-Augmented Generation) 系统的基础，模块 06 会详细讲，这里只过接口。

OpenAI Embeddings：

```typescript
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",   // 性价比首选
  dimensions: 1536,                  // 可降维
});

const vector = await embeddings.embedQuery("LangChain.js 是什么？");
console.log(vector.length);          // 1536

const vectors = await embeddings.embedDocuments([
  "第一段文本",
  "第二段文本",
]);
```

本地 Embeddings：

```typescript
import { OllamaEmbeddings } from "@langchain/ollama";

const localEmbeddings = new OllamaEmbeddings({
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434",
});
```

Embeddings 模型对比：

| 模型 | 维度 | 适用场景 |
|------|------|----------|
| `text-embedding-3-small` | 1536 | 通用，性价比最高 |
| `text-embedding-3-large` | 3072 | 高精度检索 |
| `nomic-embed-text` | 768 | 本地部署 |

## 8. 跨 Provider 的统一调用

`BaseChatModel` 是所有 Provider 的共同基类。任何接受 `BaseChatModel` 的函数都能塞 OpenAI / Anthropic / Ollama 实例进去：

```typescript
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOllama } from "@langchain/ollama";

async function ask(model: BaseChatModel, question: string) {
  const response = await model.invoke([
    { role: "system", content: "你是简洁的助手，用一句话回答。" },
    { role: "user", content: question },
  ]);
  return response.text;
}

const openai = new ChatOpenAI({ model: "gpt-4o-mini" });
const claude = new ChatAnthropic({ model: "claude-haiku-4-5", maxTokens: 1024 });
const local = new ChatOllama({ model: "llama3.1" });

const question = "用一句话解释什么是 RAG？";

console.log("OpenAI:", await ask(openai, question));
console.log("Claude:", await ask(claude, question));
console.log("Local: ", await ask(local, question));
```

这种 Provider 无关的写法在生产里很有用——你可以根据租户配置、用户 tier 在运行时挑模型。

## 9. 配合 LCEL 链式调用

Model 是 Runnable，可以直接 `.pipe()`：

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

const chain = ChatPromptTemplate
  .fromMessages([
    ["system", "你是翻译专家，将用户输入翻译为 {language}。"],
    ["human", "{text}"],
  ])
  .pipe(openai)
  .pipe(new StringOutputParser());

const result = await chain.invoke({
  language: "英文",
  text: "今天天气真好",
});
// "The weather is really nice today."
```

## 10. 模型选型速查

把上面的内容压成一张表：

| 定位 | 模型 | 适用 |
|------|------|------|
| 旗舰 | Claude Opus 4.7 / GPT-5 | 复杂推理、长文本规划 |
| 平衡 | Claude Sonnet 4.6 / GPT-4o | 大多数 Agent 工作负载 |
| 速度 | Claude Haiku 4.5 / GPT-4o-mini | 简单分类、路由、低延迟 |
| 本地 | Llama 3.1 / Qwen 2.5（Ollama） | 隐私敏感、离线开发 |

实际项目里我建议这样配：

- 开发阶段用 `gpt-4o-mini` 或 `claude-haiku-4-5`，省钱。
- 上线用 `gpt-4o` 或 `claude-sonnet-4-6`，扛得住大部分工作负载。
- 真正复杂的规划、长文本分析才升级到旗舰款。

## 小结

| 概念 | 关键点 |
|------|--------|
| Chat Model | 唯一推荐的模型抽象，输入消息列表，输出 `AIMessage` |
| 统一接口 | `invoke` / `batch` / `stream` 在所有 Provider 上一致 |
| `contentBlocks` | 多模态、工具调用、推理块都走这个统一结构 |
| Embeddings | 文本向量化，RAG 的基础 |
| 本地模型 | Ollama 让开发期零成本 |
| 模型选型 | 旗舰 / 平衡 / 速度三档，按场景挑 |

下一节进入 [Prompt Templates](./prompt-templates.md)，学习怎么把硬编码的字符串拼接换成可复用、可组合的模板。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
