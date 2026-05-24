---
title: Retriever 策略
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/QSjYwPf8fiI14ykxBV7c9LzZnqd"
last_synced: "2026-05-25T02:42:42+08:00"
---

> 模块 06 - RAG | 前置知识：[Text Splitters](./text-splitters.md)

## 检索是 RAG 的咽喉

模型再强，检索没召回正确 chunk，也只能编。这一节聚焦"怎么把对的 chunk 召回来"，按由浅到深的顺序：基础向量检索 → MMR 多样性 → metadata filter → 混合检索 → HNSW (Hierarchical Navigable Small World) 调优。Multi-Query、Self-Query、Rerank 这些更重的方案放到 [高级 RAG](./advanced-rag.md) 那一节。

## Retriever 接口和 VectorStoreRetriever

`BaseRetriever` 是 LangChain.js 的检索抽象，所有 retriever 实现一个 `invoke(query)` 拿回 `Document[]`：

```typescript
interface BaseRetriever {
  invoke(query: string): Promise<Document[]>;
}
```

最常见的来源是从向量库派生：

```typescript
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { OpenAIEmbeddings } from "@langchain/openai";

const store = await Chroma.fromExistingCollection(
  new OpenAIEmbeddings({ model: "text-embedding-3-large" }),
  { collectionName: "kb", url: "http://localhost:8000" }
);

const retriever = store.asRetriever({ k: 4 });
const docs = await retriever.invoke("退货政策是怎样的？");
```

向量库选哪个不影响 retriever 接口。`asRetriever` 在 Chroma、Qdrant、PGVector、Pinecone 上行为一致。

## similarity vs MMR：要相关还是要不重复

默认的 `similarity` 搜索就是"按向量距离排前 k"。问题在于 top-k 经常高度相似——同一段话被切成相邻 chunk，全被召回，等于浪费名额。

MMR (Maximal Marginal Relevance) 在相关度和多样性之间做平衡：先选最相关的，再选与已选差异最大的，循环到 k 个：

```typescript
const retriever = store.asRetriever({
  k: 5,
  searchType: "mmr",
  searchKwargs: {
    fetchK: 20,    // 先从向量库捞 20 个候选
    lambda: 0.6,   // 0 = 全要多样性，1 = 全要相关性
  },
});
```

`lambda` 的实操经验值：

- 0.7-0.8：偏相关，适合精确事实问答
- 0.5-0.6：平衡，开放性问题首选
- 0.3-0.4：偏多样，需要覆盖多个角度时用

什么时候用 MMR：你的文档话题集中、chunk 切得碎、top-k 经常重复。如果文档主题分布很散，纯 similarity 就够。

## k 值怎么定

k 值影响三件事：召回率、token 成本、模型注意力。经验起点：

- 没有 reranker：k=4-6
- 有 reranker：先 retrieve k=20，rerank 取 top 5
- 多步 Agent 检索：k=3，靠多次检索覆盖

k 开太大会触发 "Lost in the Middle"——LLM 对长上下文中段的信息会忽视。不要为了"安全"无脑加 k。

## metadata filter：把不该搜的剔出去

向量距离对语义"近"是有效的，但"近"不等于"对"。用户问"2026 年的退货政策"，向量可能召回一段 2023 年的旧政策因为措辞像。`metadata` 过滤能在向量搜索之前/之中精确剔除。

前提是你在 Loader 阶段把 metadata 打全（见 [Document Loaders](./document-loaders.md)）。

各家向量库的 filter 语法不统一，我把常用的列在一起：

**Chroma**（用 MongoDB 风格的查询）：

```typescript
const retriever = chromaStore.asRetriever({
  k: 5,
  filter: {
    $and: [
      { docType: { $eq: "policy" } },
      { updatedAt: { $gte: "2026-01-01" } },
      { tenantId: { $eq: "acme" } },
    ],
  },
});
```

**Qdrant**（用自己的 must/should/must_not 结构）：

```typescript
import { QdrantVectorStore } from "@langchain/community/vectorstores/qdrant";

const retriever = qdrantStore.asRetriever({
  k: 5,
  filter: {
    must: [
      { key: "metadata.docType", match: { value: "policy" } },
      { key: "metadata.updatedAt", range: { gte: "2026-01-01" } },
    ],
  },
});
```

**Pinecone**（也是 MongoDB 风格）：

```typescript
const retriever = pineconeStore.asRetriever({
  k: 5,
  filter: {
    docType: { $eq: "policy" },
    updatedAt: { $gte: "2026-01-01" },
  },
});
```

**PGVector**（透过 SQL where）：

```typescript
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";

const retriever = pgStore.asRetriever({
  k: 5,
  filter: {
    metadata_doc_type: "policy", // 实际依赖你的列设计
  },
});
```

PGVector 因为基于 Postgres，metadata 字段可以单独建索引，filter 性能是这几个里最稳的。生产里如果团队本来就有 PG，强烈推荐 PGVector。

### 动态 filter：根据用户身份注入

多租户场景里，每次请求的 filter 都不一样。把 retriever 包成函数：

```typescript
import type { VectorStore } from "@langchain/core/vectorstores";

interface UserContext {
  tenantId: string;
  permissions: string[];
}

function createScopedRetriever(store: VectorStore, ctx: UserContext) {
  return store.asRetriever({
    k: 5,
    filter: {
      $and: [
        { tenantId: { $eq: ctx.tenantId } },
        { permission: { $in: ctx.permissions } },
      ],
    },
  });
}

// 每个请求生成一个 scoped retriever
const retriever = createScopedRetriever(store, {
  tenantId: "acme",
  permissions: ["public", "internal"],
});
```

这是企业 RAG 的标准做法——共用向量库、按身份切分可见数据。

## Hybrid 检索：BM25 + 向量

向量检索擅长理解语义相似，但有两个老大难：

- **专有名词**（人名、型号、产品 SKU）模型可能根本没见过，向量距离不靠谱
- **稀有词**（"v0.3.7"、"工单 #4421"）embedding 把它压成普通词，区分度丢了

BM25 (Best Matching 25) 是经典关键词检索算法，对精确词项匹配很在行。两者一融合就是 hybrid search，互补效果显著。

LangChain.js 社区版有 `BM25Retriever`：

```typescript
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import { EnsembleRetriever } from "langchain/retrievers/ensemble";

const bm25 = BM25Retriever.fromDocuments(allChunks, { k: 10 });
const vector = store.asRetriever({ k: 10 });

const hybrid = new EnsembleRetriever({
  retrievers: [bm25, vector],
  weights: [0.4, 0.6], // 加起来 1，按经验向量略重
});

const docs = await hybrid.invoke("Claude Opus 4.7 的 thinking 参数怎么传？");
```

`EnsembleRetriever` 底层用 Reciprocal Rank Fusion (RRF) 融合：

```
RRF_score(doc) = Σ 1 / (k + rank_i(doc))
```

`k` 通常取 60，`rank_i` 是文档在第 i 个 retriever 里的排名。RRF 的好处是不依赖各 retriever 的分数量纲，跨算法融合很稳。

### 向量库原生 Hybrid

Qdrant、Pinecone、Weaviate 这些向量库现在都原生支持 sparse + dense 联合查询，省掉客户端融合的步骤。Qdrant 的写法：

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({ url: "http://localhost:6333" });

const results = await client.query("kb", {
  prefetch: [
    { query: denseVector, using: "dense", limit: 20 },
    { query: sparseVector, using: "sparse", limit: 20 },
  ],
  query: { fusion: "rrf" }, // 服务端做 RRF
  limit: 5,
});
```

服务端 hybrid 比客户端融合快得多，单次请求就完成。生产推荐这条路。LangChain.js 社区版的 Qdrant 集成在持续跟进原生 hybrid 接口，关注 [@langchain/community](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-community) 更新。

## ContextualCompressionRetriever：检索后压缩

检索回来的 chunk 可能 80% 是无关填充。让 LLM 在检索后做一次"摘要式压缩"，只保留与问题直接相关的句子：

```typescript
import { ContextualCompressionRetriever } from "langchain/retrievers/contextual_compression";
import { LLMChainExtractor } from "langchain/retrievers/document_compressors/chain_extract";
import { ChatOpenAI } from "@langchain/openai";

const cheapLlm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
const base = store.asRetriever({ k: 8 });

const compressor = LLMChainExtractor.fromLLM(cheapLlm);
const compressed = new ContextualCompressionRetriever({
  baseCompressor: compressor,
  baseRetriever: base,
});

const docs = await compressed.invoke("VIP 用户的特殊政策有哪些？");
// 每个 doc.pageContent 已经被精简到只剩相关句子
```

代价：每个 chunk 都要走一次 LLM，延迟和成本明显上升。用低成本模型（gpt-4o-mini / Claude Haiku 4.5）能压住开销，但不要把它当作默认选择。它的真正归宿是"返回的 chunk 还要进入下一步多轮检索"——这种场景下压缩省下来的 token 比 LLM 调用费贵得多。

## HNSW 参数调优

主流向量库底层都用 HNSW (Hierarchical Navigable Small World) 这一类近似最近邻算法。明白几个核心参数能在召回率、延迟、内存之间精确权衡。

HNSW 的核心思想：把向量构建成一个分层图，上层稀疏快速定位、下层密集精确搜索。三个关键参数：

| 参数 | 含义 | 调大的影响 | 调小的影响 |
|------|------|-----------|----------|
| `M` | 每个节点的连接数 | 内存增加、召回提升 | 内存省、召回下降 |
| `ef_construction` | 建索引时的搜索宽度 | 索引慢但质量高 | 索引快但质量降 |
| `ef`（或 `ef_search`） | 查询时的搜索宽度 | 查询慢但召回高 | 查询快但召回降 |

Qdrant 配置 HNSW 的写法：

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({ url: "http://localhost:6333" });

await client.createCollection("kb", {
  vectors: { size: 3072, distance: "Cosine" },
  hnsw_config: {
    m: 32,                  // 默认 16，提升召回的最常见调参
    ef_construct: 200,      // 默认 100，建索引一次性的额外耗时
  },
});

// 查询时按需调高 ef
const results = await client.search("kb", {
  vector: queryVector,
  limit: 5,
  params: { hnsw_ef: 128 }, // 默认 ef = M，调高换更准的结果
});
```

经验数字：

- **小语料（<10 万 chunk）**：默认参数完全够用，别调
- **中等语料（10 万-100 万）**：`M=24-32`，`ef_construction=150-200`，`ef_search=100-150`
- **大语料（>100 万）**：`M=32-48`，`ef_construction=200-400`，`ef_search=128-256`，准备好加内存
- **极致召回**（医疗、法律）：把 `ef_search` 调到 256-512，接受查询延迟翻倍

调参方法：用一份带标注的查询集跑 Recall@k，扫一遍 `ef_search` 取值（64/128/256/512），找出"边际收益突然下降"的点。

PGVector 0.7+ 也支持 HNSW（之前默认是 IVFFlat）：

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 32, ef_construction = 200);

-- 查询时
SET hnsw.ef_search = 128;
```

## 自定义 Retriever：业务规则混进检索

当业务有"最近 7 天的内容优先""标题命中加权"这类规则时，包一个 retriever：

```typescript
import { BaseRetriever } from "@langchain/core/retrievers";
import type { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
import { Document } from "@langchain/core/documents";
import type { VectorStore } from "@langchain/core/vectorstores";

interface FreshnessRetrieverOptions {
  vectorStore: VectorStore;
  k?: number;
  fetchK?: number;
  decayHalfLifeDays?: number;
}

class FreshnessAwareRetriever extends BaseRetriever {
  lc_namespace = ["custom", "retrievers"];
  private opts: Required<FreshnessRetrieverOptions>;

  constructor(opts: FreshnessRetrieverOptions) {
    super();
    this.opts = {
      k: 5,
      fetchK: 30,
      decayHalfLifeDays: 30,
      ...opts,
    };
  }

  async _getRelevantDocuments(
    query: string,
    _runManager?: CallbackManagerForRetrieverRun
  ): Promise<Document[]> {
    const { vectorStore, k, fetchK, decayHalfLifeDays } = this.opts;

    // 1. 粗召回
    const rough = await vectorStore.similaritySearchWithScore(query, fetchK);

    // 2. 按时间衰减重打分
    const now = Date.now();
    const lambda = Math.log(2) / (decayHalfLifeDays * 86400_000); // 半衰期换衰减系数

    const reweighted = rough.map(([doc, sim]) => {
      const updatedAt = new Date(doc.metadata.updatedAt ?? 0).getTime();
      const ageMs = now - updatedAt;
      const decay = Math.exp(-lambda * ageMs);
      return { doc, score: sim * decay };
    });

    // 3. 按综合分排序取 top-k
    reweighted.sort((a, b) => b.score - a.score);
    return reweighted.slice(0, k).map((r) => r.doc);
  }
}

// 使用
const retriever = new FreshnessAwareRetriever({
  vectorStore: store,
  k: 5,
  decayHalfLifeDays: 14, // 14 天衰减一半
});

const docs = await retriever.invoke("最近的产品更新");
```

业务规则混进检索是生产 RAG 的常态。继承 `BaseRetriever` + 实现 `_getRelevantDocuments` 是干净的扩展点。

## 选型小抄

| 场景 | 推荐组合 |
|------|---------|
| 快速验证 | VectorStore + `asRetriever({ k: 5 })` |
| 防冗余 | 加 `searchType: "mmr"`、`lambda: 0.6` |
| 精确范围 | metadata filter |
| 多租户 | scoped retriever + tenantId filter |
| 关键词重要 | BM25 + 向量 Hybrid（或向量库原生 hybrid） |
| 检索结果太脏 | ContextualCompressionRetriever（用便宜模型压缩） |
| 时间敏感 | 自定义 Retriever 做时间衰减 |
| 极致精度 | k=20 + Rerank（见 [advanced-rag](./advanced-rag.md)） |

## 小结

VectorStoreRetriever 是起点，但远不是终点。生产 RAG 的检索层至少要做这几件事：

- 切到 [Chroma](https://www.trychroma.com/) / [Qdrant](https://qdrant.tech/) / PGVector / [Pinecone](https://www.pinecone.io/) 之一，按运维和规模选
- 在 Loader 阶段把 metadata schema 设计好，retriever 这一层做 filter
- 关键词重要的场景上 BM25 hybrid
- 数据量到百万级开始调 HNSW 的 `M` 和 `ef`
- 业务规则用自定义 Retriever 注入

下一节 [高级 RAG](./advanced-rag.md) 在这套基础上叠 HyDE (Hypothetical Document Embeddings)、Rerank、Parent-Document、Query expansion 等更激进的技巧，专治 Naive RAG 治不了的问题。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
