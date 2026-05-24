---
title: VectorStore 记忆作为工具
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/VD1mwuYDMipFW0krybUctthUnee"
last_synced: "2026-05-25T02:41:29+08:00"
---

> 模块 03 - 记忆系统 | 第 4 节 | 前置：[Summary 策略 - 用 middleware 压缩历史](./summary-memory.md)

## 1.x 的思路转换：记忆不是注入，是 Agent 主动检索

前两节讲的 checkpointer 和 summary middleware，都按**时间序列**组织记忆——最近的优先注入。但很多场景下，你需要的不是"最近的对话"，而是"与当前问题最相关的历史"。

比如用户在 100 轮前说过"我对加班特别反感"，到 200 轮的时候问"这周末加班可以吗？"——按时间窗口已经看不见，按摘要可能也丢了。这时候要的是**语义检索**。

老版本里这是 `VectorStoreRetrieverMemory` 的活——框架在每次模型调用前**自动**用当前 input 检索向量库，把命中的片段拼到 prompt 里。1.x 把这个思路反过来了：

> **不再让框架被动注入，而是把"从历史里检索"做成一个工具，让 Agent 自己判断什么时候需要回忆。**

这种转变带来三个好处：

1. **省钱**：Agent 判断不需要回忆时直接跳过，不像 `VectorStoreRetrieverMemory` 每轮都要检索
2. **可解释**：Agent 调了哪条工具、检索了什么 query、返回了什么内容，整个过程在 trace 里看得清清楚楚
3. **可控**：你可以给同一个 Agent 配多个"记忆 tool"（短期、长期、特定领域），让它自己选

## 把"回忆"做成一个工具

最小可用版本，用内存向量库 + Anthropic Claude：

```typescript
// memory-tool.ts
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });
const vectorStore = new MemoryVectorStore(embeddings);

// 工具 1：检索历史
const recallMemory = tool(
  async ({ query }) => {
    const docs = await vectorStore.similaritySearch(query, 3);
    if (docs.length === 0) return "（没有找到相关的历史信息）";
    return docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join("\n");
  },
  {
    name: "recall_memory",
    description:
      "在用户的长期记忆里检索与当前问题语义相关的片段。当用户提到自己之前说过的内容、或问题涉及用户个人偏好/背景时调用。",
    schema: z.object({
      query: z.string().describe("要检索的关键词或问题，越具体越好"),
    }),
  }
);

// 工具 2：把值得长期记住的事实写入记忆
const saveMemory = tool(
  async ({ fact }) => {
    await vectorStore.addDocuments([
      new Document({
        pageContent: fact,
        metadata: { timestamp: Date.now() },
      }),
    ]);
    return `已记忆：${fact}`;
  },
  {
    name: "save_memory",
    description:
      "把用户主动透露的、值得长期记住的事实写入记忆。例如姓名、职业、偏好、关键决定。寒暄和临时信息不要写入。",
    schema: z.object({
      fact: z.string().describe("一句话事实，不要带语气词"),
    }),
  }
);

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [recallMemory, saveMemory],
  systemPrompt: `你是一个有长期记忆的助手。
- 用户透露身份、偏好等信息时，主动调 save_memory 记下来
- 用户的问题涉及他过去说过的内容时，先调 recall_memory 检索
- 不要凭印象回答，靠工具拿事实`,
  checkpointer: new MemorySaver(),
});

const config = { configurable: { thread_id: "demo" } };

await agent.invoke(
  { messages: [{ role: "user", content: "我叫李华，在上海做全栈，主要用 React + Node" }] },
  config
);

await agent.invoke(
  { messages: [{ role: "user", content: "我周末喜欢跑步和看科幻小说" }] },
  config
);

// 100 轮后……
const r = await agent.invoke(
  { messages: [{ role: "user", content: "推荐一本适合我的技术书" }] },
  config
);
console.log(r.messages.at(-1)?.text);
// Agent 会先调 recall_memory("用户的技术背景") → 拿到"React + Node + 全栈"
// 然后给出针对性建议
```

跑这段代码，从 trace 能看到 Agent 自己决定何时调 `recall_memory`、何时直接回答。系统提示里的"靠工具拿事实"这一句很关键——没有它，Claude 会倾向于直接编。

---

## Embedding 模型选择

Embedding 质量直接决定检索准确率。常用选择：

| 模型 | 维度 | 价格 | 适用 |
|------|------|------|------|
| `text-embedding-3-small` (OpenAI) | 1536（可降维） | $0.02/1M | 中英通用、性价比首选 |
| `text-embedding-3-large` (OpenAI) | 3072 | $0.13/1M | 高质量检索 |
| `bge-m3` (开源) | 1024 | 免费 | 私有部署、中文场景 |
| `Cohere embed-v3` | 1024 | $0.10/1M | Cohere 生态 |

```typescript
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
  dimensions: 1024, // text-embedding-3 支持降维
});
```

中文场景我默认 `text-embedding-3-small`，自部署上 `bge-m3` + Ollama。维度越高越精确，但存储和计算成本也涨——日常对话级别 1024 维足够用。

---

## VectorStore 后端

`MemoryVectorStore` 仅适合 demo。生产场景按基础设施挑：

| 后端 | 包 | 适用 |
|------|----|----|
| `MemoryVectorStore` | `langchain/vectorstores/memory` | 开发、测试 |
| `Chroma` | `@langchain/community/vectorstores/chroma` | 本地原型、中小规模 |
| `PGVectorStore` (pgvector) | `@langchain/community/vectorstores/pgvector` | 已有 Postgres 基建 |
| `Qdrant` | `@langchain/qdrant` | 生产高性能 |
| `Pinecone` | `@langchain/pinecone` | 全托管 SaaS |

pgvector 是我对中小型 Agent 项目的默认推荐——和 `PostgresSaver` 共用一个数据库，运维成本低：

```typescript
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });

const vectorStore = await PGVectorStore.initialize(embeddings, {
  postgresConnectionOptions: {
    connectionString: process.env.DATABASE_URL!,
  },
  tableName: "user_memories",
  columns: {
    idColumnName: "id",
    vectorColumnName: "embedding",
    contentColumnName: "content",
    metadataColumnName: "metadata",
  },
});
```

## 写入粒度：每轮 vs 抽取

什么时候往向量库里塞东西，是个工程问题。两种主流策略：

### 策略 A：每轮对话写一条（直观但噪声大）

```typescript
import { Document } from "@langchain/core/documents";

await vectorStore.addDocuments([
  new Document({
    pageContent: `用户：${userMsg}\n助手：${aiMsg}`,
    metadata: { userId, timestamp: Date.now() },
  }),
]);
```

实现简单，但寒暄、客套也都进库，检索时噪声大。

### 策略 B：让 Agent 自己抽取（前面的 `save_memory` 工具）

把"什么值得记"的判断交给模型。这是我推荐的做法，最契合 1.x 的"记忆即工具"思路。

也可以做混合：每轮全量入向量库 + 用 metadata `important: true` 标记 Agent 主动调 `save_memory` 写入的高价值条目，检索时给 important 项加权。

### 自动抽取的 middleware 模板

如果你不想让 Agent 自己调 `save_memory`，可以用 middleware 在 `afterModel` 钩子里自动抽取：

```typescript
import { createMiddleware } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const extractor = new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 });

export const autoExtractMw = createMiddleware({
  name: "auto-extract",
  afterModel: async (state) => {
    const lastUser = [...state.messages].reverse().find((m) => m.getType() === "human");
    if (!lastUser) return;

    const extract = await extractor.invoke([
      {
        role: "system",
        content:
          "提取用户消息中值得长期记住的事实（身份/偏好/决定）。没有则输出 NONE。一句话。",
      },
      { role: "user", content: lastUser.text ?? "" },
    ]);
    const fact = (typeof extract.text === "string" ? extract.text : "").trim();
    if (fact && fact !== "NONE") {
      await vectorStore.addDocuments([
        new Document({ pageContent: fact, metadata: { auto: true, ts: Date.now() } }),
      ]);
    }
  },
});
```

`afterModel` 在模型生成完之后跑，正好用来沉淀这一轮的关键信息。

## 检索调优

`similaritySearch(query, k)` 是最简形态，几个常用的进阶选项：

### MMR：兼顾相关性和多样性

```typescript
const retriever = vectorStore.asRetriever({
  k: 5,
  searchType: "mmr",
  searchKwargs: { fetchK: 20, lambda: 0.7 },
});
```

`lambda` 越接近 1 越只看相关性（容易返回近似重复的记忆），越接近 0 越看多样性（不同主题混着出）。我通常 0.5-0.7。

### 按 metadata 过滤

```typescript
const docs = await vectorStore.similaritySearch("加班", 3, {
  userId: "user-001", // 只看这个用户的记忆
});
```

多用户隔离（第 6 节）强依赖这个能力——下一节会讲。

### 阈值过滤：宁缺勿滥

向量检索默认每次都返回 `k` 条，哪怕分数很低。给一个相似度下限，避免把无关记忆喂给模型：

```typescript
const results = await vectorStore.similaritySearchWithScore("加班可以吗", 5);
const filtered = results.filter(([_, score]) => score < 0.4); // OpenAI cosine distance，越小越像
```

## 把记忆 tool 和 checkpointer 一起用

向量库提供"语义可搜的长期记忆"，checkpointer 提供"thread 内连续的短期记忆"。两者互补：

```typescript
const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [recallMemory, saveMemory],
  systemPrompt: "...",
  middleware: [autoExtractMw], // 自动沉淀
  checkpointer: new PostgresSaver(...), // 短期
});
```

实际跑起来的链路：

1. 用户问：「上周说过的那个项目预算是多少？」
2. checkpointer 把当前 thread 的近 N 轮对话恢复到 state
3. Agent 看到完整短期上下文，发现没找到"预算"
4. 主动调 `recall_memory("项目预算")`
5. 向量库返回相关片段：「公司项目预算 50 万」
6. Agent 整合回答

短期记忆和长期记忆各自做自己擅长的事。

## 淘汰策略

向量库不能无限增长。三种实用策略：

### TTL：定期清

```typescript
// 写入时记 ttl
await vectorStore.addDocuments([
  new Document({
    pageContent: fact,
    metadata: { ts: Date.now(), ttlDays: 90 },
  }),
]);

// 定期任务（pgvector 直接 SQL）
await pool.query(`DELETE FROM user_memories WHERE (metadata->>'ts')::bigint < $1`, [
  Date.now() - 90 * 24 * 3600 * 1000,
]);
```

### 重要性评分：写入时打分

```typescript
const importance = await scorer.invoke(`评估事实重要性 1-10：${fact}`);
if (parseInt(importance.text ?? "0") >= 6) {
  await vectorStore.addDocuments([new Document({ pageContent: fact, metadata: { importance } })]);
}
```

### 容量上限 + LFU

记录每条记忆的检索命中次数，超过容量时砍命中数最少的。需要向量库支持 metadata 更新——pgvector / Qdrant 都可以。

实际选型：

- 客服、临时咨询场景 → TTL 30 天
- 长期陪伴、教练类 → 重要性评分 + 容量上限
- 知识沉淀类 → 全保留，靠分类标签管理

## 小结

1.x 时代的语义记忆不再是"框架自动注入"，而是"以 tool 形式暴露给 Agent，让它主动检索"。这一思路转变让记忆系统：

- 更经济（不需要每轮都检索）
- 更可解释（trace 里能看到 Agent 调了哪条工具）
- 更可组合（同一 Agent 配多种记忆 tool）

配套实现：

- 向量库：`MemoryVectorStore` 开发用，`pgvector` 生产推荐
- 写入粒度：让 Agent 用 `save_memory` 工具自己挑，或用 `afterModel` middleware 自动抽
- 检索质量：MMR、metadata 过滤、相似度阈值是三大调优手段
- 淘汰：TTL / 重要性 / LFU 按场景选

下一节 [自定义后端：实现自己的 checkpointer / store](./custom-message-history.md) 讲怎么把 Redis 这类后端接进 LangChain 1.x 的 checkpointer / store 接口。

参考文档：[LangGraph Persistence](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
