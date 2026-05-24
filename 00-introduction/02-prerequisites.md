---
title: 前置知识清单
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/G7rIwXaLSisYO6kmJNmcP4bgnmg"
last_synced: "2026-05-25T02:40:35+08:00"
---

这一页列出我假设你已经会的东西。每一项给到"看得懂、写得出来"的程度就行，不用精通。后面没把握的话，每一节末尾我贴了我自己用过的学习资料。

我把前置知识按"硬要求 / 会简单带过 / 按需阅读"分成了三类，第一类是后面正文里不会再展开讲的，缺哪一块都得先补；第二类正文里会简单带过；第三类在用到的时候去翻一下就够。

---

## 一、TypeScript（硬要求）

LangChain.js 的 API 重度依赖 TypeScript 类型系统。这本书的代码示例全部是 TypeScript。

### 1.1 基础类型与泛型

LangChain.js 的核心接口几乎都是泛型签名。比如 `BaseChatModel<CallOptions>`、`Runnable<Input, Output>`。下面这种代码看不懂的话，得先补 TypeScript 基础：

```typescript
// 泛型函数：T 是占位类型，会在调用时被推断或显式传入
function parseOutput<T>(schema: z.ZodType<T>, raw: string): T {
  return schema.parse(JSON.parse(raw));
}

// 泛型约束：限定 T 必须实现某个接口
interface Runnable<Input, Output> {
  invoke(input: Input): Promise<Output>;
  batch(inputs: Input[]): Promise<Output[]>;
}
```

### 1.2 async/await 与异步模式

LLM 调用全是异步。下面三种写法在书里会反复出现：

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

Zod 是 LangChain.js 定义结构化输出的标准方式。`withStructuredOutput()` 直接接受 Zod schema：

```typescript
import { z } from "zod";

const ResponseSchema = z.object({
  answer: z.string().describe("回答内容"),
  confidence: z.number().min(0).max(1).describe("置信度"),
  sources: z.array(z.string()).describe("引用来源"),
});

// 从 schema 自动推导 TypeScript 类型
type Response = z.infer<typeof ResponseSchema>;
```

### 1.4 装饰器（了解即可）

LangGraph 的某些高级模式会用到装饰器语法。书里用得不多，看到能认出来就行：

```typescript
// 装饰器是一个返回函数的高阶函数
function tool(config: ToolConfig) {
  return function (target: any, key: string, descriptor: PropertyDescriptor) {
    // 包装原函数、附加元数据
  };
}
```

### 推荐资料

| 知识点 | 资料 | 类型 |
|--------|---------|------|
| TypeScript 入门 | [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/) | 官方文档 |
| 泛型 | [Beginners TypeScript - Matt Pocock](https://www.totaltypescript.com/tutorials/beginners-typescript) | 视频 |
| Zod | [Zod Docs](https://zod.dev/) | 官方文档 |
| async/await | [JavaScript.info - Async/Await](https://javascript.info/async-await) | 教程 |

---

## 二、Node.js（硬要求）

### 2.1 ES Module

LangChain.js 1.x 全面用 ESM，CommonJS 那一套（`require`、`module.exports`）在书里不会出现。`import` / `export` 的常用写法：

```typescript
// 静态导入 —— 课程全程用这种
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

// 动态导入 —— 某些场景需要按需加载
const { default: chalk } = await import("chalk");
```

关键配置：`package.json` 加 `"type": "module"`，`tsconfig.json` 里 `"module": "NodeNext"`。

### 2.2 环境变量

API Key 用环境变量管理是日常操作。`.env` 文件的常见写法：

```bash
# .env
OPENAI_API_KEY=sk-xxxx
ANTHROPIC_API_KEY=sk-ant-xxxx
LANGSMITH_API_KEY=lsv2_xxxx
```

```typescript
// 入口加载一次
import "dotenv/config";

// 任意位置读取
const apiKey = process.env.OPENAI_API_KEY;
```

### 2.3 包管理器

书里全程用 `npm`（Node 22+ 自带）。如果你已经习惯 pnpm 或 bun，把命令里的 `npm install` 换成对应命令即可。

| 包管理器 | 安装命令示例 | 备注 |
|---------|-------------|------|
| **npm**（默认） | `npm install @langchain/openai` | Node 自带，最稳定 |
| pnpm | `pnpm add @langchain/openai` | 磁盘效率高，monorepo 友好 |
| bun | `bun add @langchain/openai` | 速度最快，但生态偶有兼容问题 |

### 推荐资料

| 知识点 | 资料 | 类型 |
|--------|---------|------|
| Node.js ESM | [Node.js ESM 文档](https://nodejs.org/api/esm.html) | 官方文档 |
| npm 命令速查 | [npm Docs](https://docs.npmjs.com/cli/) | 官方文档 |
| pnpm 入门（可选） | [pnpm 中文文档](https://pnpm.io/zh/motivation) | 官方文档 |

---

## 三、AI / LLM 基础概念（会简单带过）

这一节的概念正文里用到时会简单带过。提前看一眼，读到对应章节时不会卡。

### 3.1 Token

Token 是 LLM 处理文本的最小单位。一个中文字符通常对应 1-2 个 Token，一个英文单词通常对应 1 个 Token。Token 数量影响三件事：

- **成本**：API 按 Token 数量计费（input 和 output 单价不同）
- **上下文窗口**：每个模型有 Token 上限，比如 Claude Sonnet 4.6 200K、GPT-5 1M
- **响应速度**：Token 越多，输出越慢

### 3.2 Temperature

Temperature 控制输出的随机性：

| Temperature | 效果 | 适用场景 |
|-------------|------|---------|
| 0 | 几乎确定性，同输入同输出 | 数据提取、分类、结构化输出 |
| 0.3-0.7 | 平衡创造性与一致性 | 通用对话、问答 |
| 0.8-1.0 | 高随机，输出多样 | 创意写作、头脑风暴 |

### 3.3 Prompt 工程基础

Prompt 是你和 LLM 沟通的接口。三个最常见的概念：

- **System Prompt**：约束模型的角色和行为
- **Few-shot**：在 Prompt 里附几个输入-输出示例
- **Prompt Template**：含占位符的 Prompt 模板，LangChain 的核心抽象之一

### 3.4 Embedding 与向量相似度

RAG 模块的理论基础：

- **Embedding**：把一段文本转成高维向量（典型维度 1536 / 3072），语义相近的文本向量距离更近
- **向量相似度**：衡量两段文本语义接近度的数学方法，常用余弦相似度
- **Vector Store**：存储和检索向量的数据库，比如 Chroma、Pinecone、pgvector

### 推荐资料

| 知识点 | 资料 | 类型 |
|--------|---------|------|
| LLM 工作原理 | [What are LLMs - Anthropic](https://www.anthropic.com/research) | 科普 |
| Prompt 工程 | [OpenAI Prompt Engineering](https://platform.openai.com/docs/guides/prompt-engineering) | 官方指南 |
| Embedding | [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings) | 官方文档 |
| 向量数据库 | [Pinecone Learning Center](https://www.pinecone.io/learn/) | 教程合集 |

---

## 四、HTTP / API（按需阅读）

### 4.1 REST API

LLM Provider API 都是 REST 接口，书的最后一部分（08 生产部署）还会把 Agent 包成 HTTP 服务。需要熟悉的概念：HTTP Method（GET/POST）、Request Header、Request Body（JSON）、Status Code、Bearer Token 认证。

### 4.2 SSE（Server-Sent Events）

SSE 是 LLM 流式输出的事实标准。调用 `model.stream()` 时底层走的就是 SSE：

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"好"}}]}

data: [DONE]
```

要点：单向（服务端 → 客户端）、基于 HTTP 长连接、每条消息以 `data:` 开头。

### 4.3 WebSocket（了解即可）

某些实时场景会用 WebSocket 做双向通信。书里不深入讲，但要能区分它和 SSE：

| 特性 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | 单向（服务端→客户端） | 双向 |
| 协议 | HTTP | ws:// / wss:// |
| 自动重连 | 浏览器原生支持 | 需要自己写 |
| 适用场景 | LLM 流式输出 | 实时聊天、协作编辑 |

### 推荐资料

| 知识点 | 资料 | 类型 |
|--------|---------|------|
| HTTP 基础 | [MDN HTTP 概述](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Overview) | 官方文档 |
| REST API 设计 | [RESTful API 设计指南 · 阮一峰](https://www.ruanyifeng.com/blog/2014/05/restful_api.html) | 博客 |
| SSE 详解 | [MDN Server-Sent Events](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events) | 官方文档 |

---

## 自测清单

正式开始之前，对照下面这几条过一遍，能确认的就跳过：

- 能用 TypeScript 写一个带泛型约束的函数
- 能用 `async/await` 处理几个并发异步调用
- 知道 Zod 的 `z.object()` / `z.string()` / `z.infer` 怎么用
- 用过 ES Module 的 `import` / `export` 组织代码
- 知道 `.env` 文件和 `process.env` 怎么配合
- 能解释 Token 和 Temperature 是什么
- 大致知道 Embedding 是什么
- 能说出 HTTP POST 请求的几个组成部分

8 条都能确认，直接进 [环境搭建指南](./03-setup.md)。1-2 条不确定，参考前面的推荐资料花一两天补一下。超过 3 条不确定，先把 TypeScript 和 Node.js 的基础补扎实再回来。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
