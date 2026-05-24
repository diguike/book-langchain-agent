---
title: 高级 RAG 技术
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/F2RewRsLciElKAkJL9ncVqyUnwb"
last_synced: "2026-05-25T02:42:45+08:00"
---

> 模块 06 - RAG | 前置知识：[Retriever 策略](./retrievers.md)

## Naive RAG 的天花板要靠这些招打穿

我把 Naive RAG 跑到极限（向量库选好、metadata filter、Hybrid 检索都上了），Recall@5 在我的语料上卡在 82%。剩下那 18% 召不回的，挨个看下来归成几类：

- 用户问得很口语，文档很书面（"咋退货" vs "退换货流程")
- 一个 chunk 命中了但缺前后文，LLM 看不懂
- top-k 排序粗糙，真正最相关的在第 8 名
- 用户一句话里藏了多个子问题，向量距离只对其一个有效

这几类问题对应四种治法：**HyDE / Parent-Document / Rerank / Query decomposition**。本节按"效果 vs 成本"排序，从最划算的 Rerank 讲起。

## Rerank：性价比最高的精度提升

### 为什么需要 Rerank

向量检索是粗排：把 100 万 chunk 缩到 50 个候选，速度优先，精度其次。但用户只看 top 5，粗排的第 8 名很可能比第 2 名更相关。

Rerank 就是在粗排后做一次精排：用更强的模型（通常是 cross-encoder，一次处理 query + doc 一对）对候选打分重排。流程：

```
粗排（向量 / BM25 / Hybrid）→ top 20-50 → Rerank（cross-encoder）→ top 3-5
```

### Cohere Rerank：托管最方便

[Cohere Rerank](https://docs.cohere.com/docs/rerank) 是目前商用 reranker 的事实标杆，最新版本 `rerank-3.5` 支持 100+ 语言。

```bash
npm install @langchain/cohere
```

```typescript
import { CohereRerank } from "@langchain/cohere";
import { ContextualCompressionRetriever } from "langchain/retrievers/contextual_compression";

const reranker = new CohereRerank({
  apiKey: process.env.COHERE_API_KEY!,
  model: "rerank-v3.5",
  topN: 5,
});

const rerankedRetriever = new ContextualCompressionRetriever({
  baseCompressor: reranker,
  baseRetriever: store.asRetriever({ k: 25 }), // 粗排捞 25 个
});

const docs = await rerankedRetriever.invoke("VIP 用户退货政策有什么特别的？");
```

代价：每次查询多一次 Cohere API 调用，p99 延迟 +200-400ms，按 token 计费。我的项目里 Rerank 平均能把 Recall@5 提升 8-15 个百分点，性价比无敌。

### Voyage rerank-2：另一个值得考虑的选项

[Voyage AI](https://www.voyageai.com/) 是 Anthropic 投资的 embedding/rerank 公司，他们的 `rerank-2` 在中英文都很强，价格比 Cohere 略低。LangChain.js 1.x 通过 `@langchain/community` 集成：

```typescript
import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
// rerank 走 HTTP API，封一个 BaseDocumentCompressor

import { BaseDocumentCompressor } from "@langchain/core/retrievers/document_compressors";
import { Document } from "@langchain/core/documents";

class VoyageRerank extends BaseDocumentCompressor {
  constructor(
    private apiKey: string,
    private model = "rerank-2",
    private topN = 5
  ) {
    super();
  }

  async compressDocuments(documents: Document[], query: string): Promise<Document[]> {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        documents: documents.map((d) => d.pageContent),
        model: this.model,
        top_k: this.topN,
      }),
    });

    const data = (await res.json()) as {
      data: Array<{ index: number; relevance_score: number }>;
    };

    return data.data.map((item) => {
      const doc = documents[item.index];
      doc.metadata.rerankScore = item.relevance_score;
      return doc;
    });
  }
}
```

### BGE-reranker：自部署、零外部调用

如果数据敏感不能出网，或者要省钱，部署 [BGE-reranker](https://huggingface.co/BAAI/bge-reranker-v2-m3) 是稳妥选项。智源研究院（BAAI）开源的 reranker 在 MTEB 排行榜上常年靠前，`bge-reranker-v2-m3` 多语言版只有 568M 参数，单卡能跑。

部署方式之一是用 [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) 这个 Rust 服务：

```bash
docker run -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:1.5 \
  --model-id BAAI/bge-reranker-v2-m3
```

封装成 LangChain 兼容的 compressor：

```typescript
import { BaseDocumentCompressor } from "@langchain/core/retrievers/document_compressors";
import { Document } from "@langchain/core/documents";

class BgeRerank extends BaseDocumentCompressor {
  constructor(
    private endpoint = "http://localhost:8080/rerank",
    private topN = 5
  ) {
    super();
  }

  async compressDocuments(documents: Document[], query: string): Promise<Document[]> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        texts: documents.map((d) => d.pageContent),
        raw_scores: false,
      }),
    });

    const scored = (await res.json()) as Array<{ index: number; score: number }>;
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topN)
      .map((s) => {
        const doc = documents[s.index];
        doc.metadata.rerankScore = s.score;
        return doc;
      });
  }
}
```

经验：小规模索引用 Cohere，大规模索引 + 数据敏感用 BGE 自部署，单卡 A10 / L4 能撑住 500-1000 QPS。

## HyDE：让假想答案当作查询向量

### 思路

用户问得口语，文档写得书面。直接把口语 query 做 embedding，跟书面 doc 的 embedding 距离就远。HyDE (Hypothetical Document Embeddings) 的奇妙转换：先让 LLM 编一个"假想答案"，再用假想答案的 embedding 去检索。假想答案的措辞已经偏书面，跟真文档的距离反而近。

```
用户："咋退货？"
   ↓ LLM 生成假想答案
"用户可在订单签收后 7 日内联系客服发起退货申请，VIP 用户延长至 14 日..."
   ↓ embedding 这段假想答案
   ↓ 在向量库里找最相似的真文档
```

### 实现

```typescript
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { VectorStore } from "@langchain/core/vectorstores";
import type { Document } from "@langchain/core/documents";

interface HydeOptions {
  vectorStore: VectorStore;
  llm: ChatOpenAI;
  k?: number;
  numHypotheses?: number; // 生成几个假想答案
}

async function hydeRetrieve(
  query: string,
  opts: HydeOptions
): Promise<Document[]> {
  const { vectorStore, llm, k = 5, numHypotheses = 1 } = opts;

  // 1. 让 LLM 写假想答案
  const prompt = `请直接写一段简短的资料文档来回答这个问题。
直接输出资料正文，不要"以下是""答案是"这类引导语。

问题: ${query}

资料:`;

  const hypotheses: string[] = [];
  for (let i = 0; i < numHypotheses; i++) {
    const r = await llm.invoke(prompt, {
      temperature: 0.4 + i * 0.1, // 多个版本用不同 temperature 增加多样性
    });
    const text = r.contentBlocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    hypotheses.push(text);
  }

  // 2. 用每个假想答案分别检索，合并去重
  const seen = new Set<string>();
  const merged: Document[] = [];
  for (const hyp of hypotheses) {
    const docs = await vectorStore.similaritySearch(hyp, k);
    for (const d of docs) {
      const key = d.metadata.source ? `${d.metadata.source}:${d.pageContent.slice(0, 50)}` : d.pageContent;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(d);
      }
    }
  }

  return merged.slice(0, k);
}

// 用法
const docs = await hydeRetrieve("咋退货？", {
  vectorStore: store,
  llm: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 }),
  numHypotheses: 1,
});
```

### 什么时候用 HyDE

- 用户和文档"语言风格"差异大（口语 vs 法规、中文 vs 英文）
- 探索性问题（"这个产品有什么好玩的功能"）模型能猜测合理答案
- 不适合：用户问的是文档里不存在的概念，LLM 编出来的假想答案会带你跑偏。这种场景宁可让检索失败也别用 HyDE 把错误延伸下去

代价：每次查询多一次 LLM 调用。用便宜模型（gpt-4o-mini）压住成本。

## Parent-Document Retriever：小块召回、大块入 prompt

### 思路

切块的两难：小块召回精准但缺上下文，大块上下文充分但召回不准。Parent-Document Retriever 两边通吃——用小块做 embedding 和检索，命中后返回它所属的大块给 LLM。

```
原文档 1500 字
├── 子块 1 (150 字) ← embedding 入库，召回阶段命中
├── 子块 2 (150 字)
├── 子块 3 (150 字)
└── ...

命中子块 1 → 拼到 prompt 的是子块 1 所属的"父块"（如 800 字）
```

### 实现

```typescript
import { ParentDocumentRetriever } from "langchain/retrievers/parent_document";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { InMemoryStore } from "@langchain/core/stores";
import { OpenAIEmbeddings } from "@langchain/openai";

const vectorStore = await Chroma.fromExistingCollection(
  new OpenAIEmbeddings({ model: "text-embedding-3-large" }),
  { collectionName: "child-chunks", url: "http://localhost:8000" }
);

// 父块存 KV，可以用 InMemoryStore 或 Redis-based 实现
const docStore = new InMemoryStore();

const childSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 200,
  chunkOverlap: 30,
});

const parentSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 100,
});

const retriever = new ParentDocumentRetriever({
  vectorstore: vectorStore,
  docstore: docStore,
  childSplitter,
  parentSplitter,
  childK: 4,   // 召回 4 个子块
  parentK: 2,  // 去重后返回它们对应的 2 个父块
});

await retriever.addDocuments(rawDocs);

const docs = await retriever.invoke("VIP 用户退货时限是多久？");
// 返回的是大块（约 1000 字），即使命中点是 200 字小块
```

生产里 `docStore` 不能用 `InMemoryStore`，进程一关就丢。常见做法：写个 Redis / Postgres 版本，实现 `BaseStore` 接口即可。

### 什么时候用

- 用户问题需要看上下文才能正确回答（"它和上一段说的是同一个意思吗"）
- 切块切得很碎（chunkSize < 300）召回精准但 LLM 看不懂
- 不适合：FAQ 这种"一问一答"的短文档，没有父子结构可言

## Query Expansion 和 Decomposition

### Multi-Query：一个问题多角度问

一个用户问题往往可以从多角度表述。让 LLM 改写成多个版本，分别检索，结果合并：

```typescript
import { MultiQueryRetriever } from "langchain/retrievers/multi_query";
import { ChatOpenAI } from "@langchain/openai";

const expander = MultiQueryRetriever.fromLLM({
  llm: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.4 }),
  retriever: store.asRetriever({ k: 4 }),
  queryCount: 3, // 生成 3 个改写版本
});

const docs = await expander.invoke("怎么调 RAG 的 chunkSize");
// 内部生成例如：
// 1. "RecursiveCharacterTextSplitter 的 chunkSize 推荐值"
// 2. "RAG 分块大小调优经验"
// 3. "文本分块 chunk size 对检索效果的影响"
// 分别检索后合并去重
```

代价：3 次检索 + 1 次 LLM 改写。适合"用户表达模糊"的客服场景。

### Decomposition：拆分多步问题

用户问"对比 A 政策和 B 政策的退款条款有什么区别"——这是两个检索任务捆在一起。直接做向量检索，可能 A 召回了 B 没召回，或者两个都召回但片段不完整。

正确的做法是先拆问题再分别检索：

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { VectorStore } from "@langchain/core/vectorstores";
import type { Document } from "@langchain/core/documents";

const decomposeSchema = z.object({
  subQuestions: z
    .array(z.string())
    .describe("拆分后的、可以独立检索的子问题列表"),
});

async function decomposeAndRetrieve(
  query: string,
  store: VectorStore,
  llm: ChatOpenAI
): Promise<Document[]> {
  // 1. 拆问题
  const structured = llm.withStructuredOutput(decomposeSchema, {
    strategy: "tool",
  });
  const { subQuestions } = await structured.invoke(
    `把下面这个问题拆成 1-4 个可以独立检索的子问题。每个子问题必须能被向量检索单独回答。
如果问题本身已经够独立，返回 [原问题]。

问题: ${query}`
  );

  // 2. 每个子问题检索
  const merged: Document[] = [];
  const seen = new Set<string>();
  for (const sub of subQuestions) {
    const docs = await store.similaritySearch(sub, 3);
    for (const d of docs) {
      const key = `${d.metadata.source}:${d.pageContent.slice(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(d);
      }
    }
  }
  return merged;
}

const docs = await decomposeAndRetrieve(
  "对比 A 政策和 B 政策的退款条款有什么区别",
  store,
  new ChatOpenAI({ model: "gpt-4o", temperature: 0 })
);
```

Decomposition 跟 Multi-Query 的区别：Multi-Query 是同一个问题的同义改写（求并集），Decomposition 是真把问题拆成不同子任务（每个都是独立问题）。

更彻底的做法是让 Agent 自己决定要不要拆、要拆成几个，见 [rag-agent](./rag-agent.md)。

## 评估：把 RAG 调优从"凭感觉"变成"看数字"

调到这里你已经堆了一堆技术，问题来了——到底有没有比 Naive RAG 好？多多少？这就要量化评估。

最小指标集是三个：

- **Recall@k**：标准答案对应的 chunk 是否进入了 top-k。纯检索层指标，不依赖 LLM，能直接反映召回质量。
- **Faithfulness**：答案里的每一句话能不能在检索到的 context 中找到支撑。用 LLM-as-Judge 判断幻觉率。
- **Answer Relevancy**：答案是不是真的回答了用户问题，还是答非所问。同样用 judge 模型打分。

完整的样本结构、判分 prompt、闭环代码和 LangSmith 集成，见 [评估方法与指标](../07-observability/evaluation.md)。专业评估框架（[Ragas](https://docs.ragas.io/)、[DeepEval](https://docs.confident-ai.com/)）也是这套思路，只是指标更细。

50-100 条标注样本就能跑出有意义的数据。每次调"上 X 技术前 vs 后"，让指标说话，不要拍脑袋。

## 高级 RAG 组合管线示例

把 HyDE + Hybrid + Rerank 三件套组合起来：

```typescript
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import { EnsembleRetriever } from "langchain/retrievers/ensemble";
import { ContextualCompressionRetriever } from "langchain/retrievers/contextual_compression";
import { CohereRerank } from "@langchain/cohere";
import { Document } from "@langchain/core/documents";

async function buildAdvancedRetriever(allChunks: Document[]) {
  // 向量库
  const vectorStore = await Chroma.fromDocuments(
    allChunks,
    new OpenAIEmbeddings({ model: "text-embedding-3-large" }),
    { collectionName: "kb", url: "http://localhost:8000" }
  );

  // Hybrid 粗排
  const bm25 = BM25Retriever.fromDocuments(allChunks, { k: 15 });
  const dense = vectorStore.asRetriever({ k: 15, searchType: "mmr" });
  const hybrid = new EnsembleRetriever({
    retrievers: [bm25, dense],
    weights: [0.3, 0.7],
  });

  // Rerank 精排
  return new ContextualCompressionRetriever({
    baseCompressor: new CohereRerank({
      apiKey: process.env.COHERE_API_KEY!,
      model: "rerank-v3.5",
      topN: 5,
    }),
    baseRetriever: hybrid,
  });
}

// HyDE 包装层
async function askWithHyde(
  question: string,
  retriever: { invoke(q: string): Promise<Document[]> }
) {
  const cheap = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.3 });
  const main = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });

  // 1. HyDE 假想答案
  const hypo = await cheap.invoke(`简短写一段资料回答: ${question}`);
  const hypoText = hypo.contentBlocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  // 2. 拿假想答案去做 Hybrid + Rerank
  const docs = await retriever.invoke(hypoText);

  // 3. 真生成
  const context = docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join("\n\n");
  const answer = await main.invoke(
    `只根据资料回答，在相关句末标 [编号]。资料没说就直说不知道。

资料:
${context}

问题: ${question}`
  );

  return {
    answer: answer.contentBlocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
    docs,
  };
}
```

这条管线在我手上的项目里把 Recall@5 从 82% 推到 94%，Faithfulness 从 0.71 推到 0.89。代价是单次问答从 1.2s 涨到 3.8s，单次 cost 涨 4x。值不值看场景。

## 选型矩阵

| 痛点 | 推荐技术 | 额外延迟 | 额外成本 |
|------|----------|---------|---------|
| 排序粗糙、top-k 漏关键 | Rerank（Cohere / Voyage / BGE） | +200-400ms | +1 次 rerank 调用 |
| 用户口语 vs 文档书面 | HyDE | +400-800ms | +1 次 LLM |
| 小块准但缺上下文 | Parent-Document Retriever | 无 | +存储 2-3x |
| 问题模糊 / 表达多样 | Multi-Query | +1-2s | +1 次 LLM + Nx 检索 |
| 一句话多个子问题 | Decomposition | +1-2s | +1 次 LLM + Nx 检索 |
| 检索片段太脏 | ContextualCompression | +0.5-1s | +1 次便宜 LLM |
| 数据敏感不能出网 | BGE-reranker 自部署 | 看部署规模 | +GPU 推理 |

## 小结

Naive RAG 跑到 80 分以后再往上走，每个百分点都要付出代价。最划算的两个动作：

1. **Rerank**：粗排 + 精排两段式，性价比最高，必上
2. **量化评估**：50 条标注样本 + 三指标（Recall / Faithfulness / Relevancy），让每次调整都有数据支撑

HyDE / Parent-Document / Multi-Query / Decomposition 是对症下药的工具，不是默认配置。先用评估找出真正的瓶颈，再针对性引入。

下一节 [RAG Agent](./rag-agent.md) 把所有这些技术从"固定管线"升级成"Agent 自主决策"——什么时候要检索、检索哪个库、要不要 rerank、置信度不够要不要回退到 web search，全部交给 LangGraph 状态机。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
