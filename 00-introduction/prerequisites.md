---
title: 前置知识清单
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/G7rIwXaLSisYO6kmJNmcP4bgnmg"
last_synced: "2026-05-25T02:40:35+08:00"
---

本页列出学习本课程所需的前置知识。你不需要精通每一项，但至少需要 **"能看懂、会用"** 的程度。每项知识都标注了重要程度和推荐学习资源，方便你按需补课。

> **阅读提示：** 标注 ★★★ 的是硬性前置条件，课程中不会再详细讲解；标注 ★★ 的会在课程中简要回顾；标注 ★ 的可以在学到相关模块时再补。

---

## 一、TypeScript 必备知识 ★★★

LangChain.js 深度依赖 TypeScript 的类型系统。以下是你必须掌握的 TypeScript 特性：

### 1.1 基础类型与泛型

LangChain.js 的核心接口全部基于泛型设计。例如 `BaseChatModel<CallOptions>`, `Runnable<Input, Output>`。你需要能看懂和编写这样的代码：

```typescript
// 泛型函数：你需要理解 T 在这里的作用
function parseOutput<T>(schema: z.ZodType<T>, raw: string): T {
  return schema.parse(JSON.parse(raw));
}

// 泛型约束：限制 T 必须满足某个接口
interface Runnable<Input, Output> {
  invoke(input: Input): Promise<Output>;
  batch(inputs: Input[]): Promise<Output[]>;
}
```

### 1.2 async/await 与异步模式

LLM 调用本质上全是异步操作。你必须熟练使用 `async/await`，并理解以下模式：

```typescript
// 基本异步调用
const result = await model.invoke("Hello");

// 并发调用
const results = await Promise.all([
  model.invoke("Query 1"),
  model.invoke("Query 2"),
]);

// AsyncGenerator —— 流式输出的基础
async function* streamTokens() {
  for await (const chunk of await model.stream("Hello")) {
    // 1.x 多模态统一用 contentBlocks，纯文本场景可读 chunk.text
    yield chunk.text;
  }
}
```

### 1.3 Zod Schema

Zod 是 LangChain.js 中定义结构化输出的标准方式。`withStructuredOutput()` 方法直接接受 Zod schema：

```typescript
import { z } from "zod";

// 定义一个 schema
const ResponseSchema = z.object({
  answer: z.string().describe("回答内容"),
  confidence: z.number().min(0).max(1).describe("置信度"),
  sources: z.array(z.string()).describe("引用来源"),
});

// 类型推导：从 schema 自动获得 TypeScript 类型
type Response = z.infer<typeof ResponseSchema>;
```

### 1.4 装饰器（了解即可）

LangGraph.js 中某些高级模式会用到装饰器语法。你只需理解基本概念：

```typescript
// 装饰器本质是一个高阶函数
function tool(config: ToolConfig) {
  return function (target: any, key: string, descriptor: PropertyDescriptor) {
    // 包装原函数，添加元数据
  };
}
```

### 推荐学习资源

| 知识点 | 推荐资源 | 类型 |
|--------|---------|------|
| TypeScript 全面入门 | [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/) | 官方文档 |
| 泛型深入理解 | [TypeScript Generics - Matt Pocock](https://www.totaltypescript.com/tutorials/beginners-typescript) | 视频教程 |
| Zod 文档 | [Zod Official Docs](https://zod.dev/) | 官方文档 |
| async/await 原理 | [JavaScript.info - Async/Await](https://javascript.info/async-await) | 在线教程 |

---

## 二、Node.js 基础 ★★★

### 2.1 ES Module 体系

LangChain.js 1.x 全面使用 ESM。你需要理解 `import/export` 语法以及 ESM 与 CommonJS 的区别：

```typescript
// ESM 导入 —— 课程全程使用此格式
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

// 动态导入 —— 某些场景需要
const { default: chalk } = await import("chalk");
```

关键配置：`package.json` 中设置 `"type": "module"`，`tsconfig.json` 中设置 `"module": "NodeNext"`。

### 2.2 环境变量管理

API Key 管理是 LLM 应用开发的日常操作：

```bash
# .env 文件
OPENAI_API_KEY=sk-xxxx
ANTHROPIC_API_KEY=sk-ant-xxxx
LANGSMITH_API_KEY=lsv2_xxxx
```

```typescript
// 加载环境变量
import "dotenv/config";

// 访问
const apiKey = process.env.OPENAI_API_KEY;
```

### 2.3 包管理器

本书默认用 `npm`（Node 22+ 自带，全书示例统一）。如果你已经习惯 pnpm 或 bun，命令稍作替换即可：

| 包管理器 | 安装命令示例 | 备注 |
|---------|-------------|------|
| **npm** (默认) | `npm install @langchain/openai` | Node 自带，命令最稳定 |
| pnpm | `pnpm add @langchain/openai` | 磁盘效率高，monorepo 友好 |
| bun | `bun add @langchain/openai` | 速度最快，但生态兼容性偶有问题 |

### 推荐学习资源

| 知识点 | 推荐资源 | 类型 |
|--------|---------|------|
| Node.js ESM | [Node.js ESM 文档](https://nodejs.org/api/esm.html) | 官方文档 |
| npm 命令速查 | [npm Docs](https://docs.npmjs.com/cli/) | 官方文档 |
| pnpm 入门（可选） | [pnpm 官方文档](https://pnpm.io/zh/motivation) | 官方文档（中文） |

---

## 三、AI / LLM 基础概念 ★★

这些概念课程中会在用到时简要回顾，但提前了解能显著提升学习效率。

### 3.1 Token

Token 是 LLM 处理文本的基本单位。一个中文字符通常对应 1-2 个 Token，一个英文单词通常对应 1 个 Token。Token 数量直接影响：

- **成本：** API 按 Token 数量计费（区分 input token 和 output token）
- **上下文窗口：** 每个模型有 Token 上限（如 Claude Sonnet 4.6 支持 200K，GPT-5 支持 1M）
- **响应速度：** Token 数量越多，响应越慢

### 3.2 Temperature

Temperature 控制模型输出的随机性：

| Temperature | 效果 | 适用场景 |
|-------------|------|---------|
| 0 | 几乎确定性输出，每次结果基本一致 | 数据提取、分类、结构化输出 |
| 0.3-0.7 | 平衡创造性与一致性 | 通用对话、问答 |
| 0.8-1.0 | 高随机性，输出多样 | 创意写作、头脑风暴 |

### 3.3 Prompt 工程基础

Prompt 是你与 LLM 沟通的接口。核心概念包括：

- **System Prompt：** 定义 LLM 的角色和行为约束
- **Few-shot：** 在 Prompt 中给出输入-输出示例
- **Prompt Template：** 包含变量占位符的可复用 Prompt（LangChain 的核心概念）

### 3.4 Embedding 与向量相似度

这是 RAG 模块的理论基础：

- **Embedding：** 将文本转化为高维向量（如 1536 维），语义相近的文本向量距离更近
- **向量相似度：** 衡量两段文本语义接近程度的数学方法（常用余弦相似度）
- **Vector Store：** 专门存储和检索向量的数据库（如 Chroma、Pinecone、pgvector）

### 推荐学习资源

| 知识点 | 推荐资源 | 类型 |
|--------|---------|------|
| LLM 工作原理 | [What are LLMs - Anthropic](https://www.anthropic.com/research) | 科普文章 |
| Prompt 工程指南 | [OpenAI Prompt Engineering](https://platform.openai.com/docs/guides/prompt-engineering) | 官方指南 |
| Embedding 概念 | [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings) | 官方文档 |
| 向量数据库入门 | [Pinecone Learning Center](https://www.pinecone.io/learn/) | 教程合集 |

---

## 四、HTTP / API 基础 ★

### 4.1 REST API

你需要理解基本的 HTTP 请求/响应模型，因为：

- 所有 LLM Provider API 都是 REST 接口
- 课程最终会将 Agent 部署为 HTTP API 服务

核心概念：HTTP Method (GET/POST)、Request Header、Request Body (JSON)、Status Code、Authentication (Bearer Token)。

### 4.2 SSE (Server-Sent Events)

SSE 是 LLM 流式输出的标准协议。当你调用 `model.stream()` 时，底层就是 SSE：

```
// SSE 数据格式
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"好"}}]}

data: [DONE]
```

你需要理解：SSE 是单向的（服务端 → 客户端）、基于 HTTP 长连接、每条消息以 `data:` 开头。

### 4.3 WebSocket（了解即可）

某些实时 Agent 场景会使用 WebSocket 进行双向通信。本课程不会深入，但你应了解它与 SSE 的区别：

| 特性 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | 单向（服务端→客户端） | 双向 |
| 协议 | HTTP | ws:// / wss:// |
| 自动重连 | 浏览器内置支持 | 需手动实现 |
| 适用场景 | LLM 流式输出 | 实时聊天、协作编辑 |

### 推荐学习资源

| 知识点 | 推荐资源 | 类型 |
|--------|---------|------|
| HTTP 基础 | [MDN HTTP 概述](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Overview) | 官方文档（中文） |
| REST API 设计 | [RESTful API 设计指南 - 阮一峰](https://www.ruanyifeng.com/blog/2014/05/restful_api.html) | 博客 |
| SSE 详解 | [MDN Server-Sent Events](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events) | 官方文档（中文） |

---

## 自测清单

在开始正式学习之前，请确认以下事项。如果你对某项打了 ✗，强烈建议先花时间补上：

```
[ ] 我能用 TypeScript 写一个带泛型约束的函数
[ ] 我能用 async/await 处理多个并发异步操作
[ ] 我知道 Zod 的 z.object()、z.string()、z.infer 怎么用
[ ] 我能用 ES Module 的 import/export 组织代码
[ ] 我知道 .env 文件和 process.env 的关系
[ ] 我能解释什么是 Token 和 Temperature
[ ] 我知道 Embedding 的基本概念
[ ] 我能说出 HTTP POST 请求的基本组成部分
```

> **全部打勾？** 太好了，请前往 [环境搭建指南](./setup.md) 配置你的开发环境。
>
> **有 1-2 项不确定？** 没关系，利用上面的推荐资源花 1-2 天补课即可。
>
> **超过 3 项不确定？** 建议先系统学习 TypeScript 和 Node.js 基础，再回来开始本课程。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
