---
title: Text Splitters
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/PGcDwgnA4iUDgFkopW2cOcKjnhb"
last_synced: "2026-05-25T02:42:38+08:00"
---

> 模块 06 - RAG | 前置知识：[Document Loaders](./02-document-loaders.md)

## 分块是 RAG 里最划算的调优环节

调 RAG 准确率最便宜的方式不是换 embedding 模型，也不是换向量库，是把分块做对。一个文档切得好不好，决定了召回精度的天花板。我手上有个项目，光是把 `chunkSize` 从 1500 调到 600、再叠加 `MarkdownHeaderTextSplitter`，Recall@5 从 0.62 拉到了 0.81——比换 reranker 还有效。

为什么分块这么关键，搞清楚三件事就够：

1. **Embedding 模型有最优输入长度**：大多数 embedding 模型在 256-512 token 输入下质量最高，超过 1000 token 后向量会"糊掉"——一个 chunk 讲了 5 件事，向量是这 5 件事的平均，匹配哪件都不准
2. **chunk 是检索的最小单位**：一个 chunk 装两段无关内容，命中其中一段时另一段就是噪声
3. **Context 不是越多越好**：研究反复证明 LLM 存在 "Lost in the Middle"——上下文中间段的信息会被忽略，塞 20K token 不如精准给 2K

分块要解决的是粒度平衡：太大噪声多，太小丢上下文。本节按"够用到精细"的顺序讲四种 splitter。

## RecursiveCharacterTextSplitter：默认选它

90% 的场景用这个就行。它按一组优先级的分隔符递归切，能尽量保留段落和句子完整。

```typescript
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,      // 每块最大字符数
  chunkOverlap: 120,   // 相邻块重叠
});

const chunks = await splitter.splitDocuments(docs);
```

工作机制：先按 `\n\n`（段落）切；某段超过 `chunkSize` 时降级用 `\n`（行）；还超就用 ` `（空格）；最后才硬切字符。这样能尽量让一个 chunk 是一个完整段落，而不是腰斩。

### 中文优化

默认分隔符按英文设计，中文密集文本要补一组：

```typescript
const cnSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 80,
  separators: [
    "\n\n",  // 段落
    "\n",    // 换行
    "。",
    "！",
    "？",
    "；",
    "，",
    " ",
    "",
  ],
});
```

中文一字一 token 更贵，`chunkSize` 比英文小一点（500-700 字符）效果更稳。

### 代码文档要按语言切

代码不能按段落切，要按函数/类边界切。`fromLanguage` 内置了 15+ 种语言的分隔符：

```typescript
const tsSplitter = RecursiveCharacterTextSplitter.fromLanguage("js", {
  chunkSize: 1200,
  chunkOverlap: 150,
});

// 内部用了 ["\nclass ", "\nfunction ", "\nconst ", "\n\n", ...] 等 TS/JS 友好的分隔符
const codeChunks = await tsSplitter.splitDocuments(sourceFiles);
```

## MarkdownHeaderTextSplitter：结构化文档的正解

Markdown 文档有现成的结构（标题层级），按结构切比按字符切准得多。`MarkdownHeaderTextSplitter` 沿标题切分，并把 H1/H2/H3 写进每个 chunk 的 metadata。

```typescript
import { MarkdownHeaderTextSplitter } from "@langchain/textsplitters";

const splitter = new MarkdownHeaderTextSplitter({
  headersToSplitOn: [
    ["#", "h1"],
    ["##", "h2"],
    ["###", "h3"],
  ],
});

const md = `
# 产品手册

## 安装

需要 Node.js 22+。

## API 参考

### createAgent

主入口函数。
`;

const chunks = await splitter.splitText(md);
// chunks[0].metadata -> { h1: "产品手册", h2: "安装" }
// chunks[1].metadata -> { h1: "产品手册", h2: "API 参考", h3: "createAgent" }
```

为什么这事重要：标题信息进 metadata 后，下游可以做两件事：

1. **检索时按 metadata filter**——比如只搜 `h2: "API 参考"` 下的内容
2. **拼 prompt 时把标题路径带上**——让模型知道这段话出自哪一节，回答时引用更准

### 标题切完还要再切一次

按标题切完，一个 section 仍可能超过 `chunkSize`。标准做法是两段流水线：

```typescript
import { MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const headerSplitter = new MarkdownHeaderTextSplitter({
  headersToSplitOn: [
    ["#", "h1"],
    ["##", "h2"],
    ["###", "h3"],
  ],
});

const charSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 600,
  chunkOverlap: 100,
});

const headerChunks = await headerSplitter.splitText(md);
const finalChunks = await charSplitter.splitDocuments(headerChunks);
// 标题 metadata 会被自动继承到二次切分后的小 chunk 上
```

HTML 文档同理，用 `HTMLHeaderTextSplitter`（同包导出），逻辑一样。

## TokenTextSplitter：贴着 token 预算切

字符数和 token 数不是 1:1。中文一字 1.5-2 token，英文一词 1-2 token。如果你的痛点是"塞进 prompt 的总 token 数超了"，按 token 切更准：

```bash
npm install @langchain/textsplitters js-tiktoken
```

```typescript
import { TokenTextSplitter } from "@langchain/textsplitters";

const splitter = new TokenTextSplitter({
  encodingName: "cl100k_base", // GPT-4o / GPT-4.1 / GPT-5 通用
  chunkSize: 256,
  chunkOverlap: 32,
});

const chunks = await splitter.splitDocuments(docs);
```

适用场景：

- embedding 模型按 token 限长（如 `text-embedding-3-large` 上限 8192 token）
- 后续 LLM 上下文很紧，要精确控制总 token
- 跨语言混合文档，字符数估算误差大

注意 `cl100k_base` 是 OpenAI 的 BPE 编码；Claude 用的是另一套 tokenizer，但近似精度够用。

## 语义分块：用 embedding 距离找断点

前面四种都是基于规则切。规则的根本问题是它不懂语义——一段讲完 A 接着讲 B，规则不知道这里该断开。

语义分块的思路：先按句子粗切，计算相邻句子的 embedding 距离，距离突然变大的地方就是话题切换点。LangChain.js 1.x 没有内置的 `SemanticChunker`，但实现起来 30 行：

```typescript
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";

interface SemanticChunkerOptions {
  embeddings: OpenAIEmbeddings;
  breakpointPercentile?: number; // 默认 90 分位
  bufferSize?: number;           // 相邻几句一起算向量，默认 1
  metadata?: Record<string, unknown>; // 透传到每个 chunk 的 metadata
}

async function semanticChunk(
  text: string,
  opts: SemanticChunkerOptions
): Promise<Document[]> {
  const { embeddings, breakpointPercentile = 90, bufferSize = 1, metadata = {} } = opts;

  // 1. 按句号粗切
  const sentences = text
    .split(/(?<=[。！？.!?])\s*/)
    .filter((s) => s.trim().length > 0);

  // 2. 每个位置取 bufferSize 个句子拼起来做 embedding
  const grouped = sentences.map((_, i) => {
    const start = Math.max(0, i - bufferSize);
    const end = Math.min(sentences.length, i + bufferSize + 1);
    return sentences.slice(start, end).join(" ");
  });

  const vectors = await embeddings.embedDocuments(grouped);

  // 3. 计算相邻向量的余弦距离
  const distances: number[] = [];
  for (let i = 0; i < vectors.length - 1; i++) {
    distances.push(1 - cosine(vectors[i], vectors[i + 1]));
  }

  // 4. 距离超过分位阈值的点 = 断点
  const threshold = percentile(distances, breakpointPercentile);
  const breakpoints = distances
    .map((d, i) => (d > threshold ? i + 1 : -1))
    .filter((i) => i > 0);

  // 5. 按断点切 chunk
  const chunks: Document[] = [];
  let start = 0;
  for (const bp of [...breakpoints, sentences.length]) {
    chunks.push(
      new Document({
        pageContent: sentences.slice(start, bp).join(""),
        metadata: { ...metadata },
      })
    );
    start = bp;
  }

  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length * p) / 100)];
}

// 用法
const chunks = await semanticChunk(longText, {
  embeddings: new OpenAIEmbeddings({ model: "text-embedding-3-large" }),
  breakpointPercentile: 88,
});
```

什么时候值得上语义分块：

- 长篇叙述类文档（论文、技术博客、政策汇编），话题切换频繁
- 规则切完发现 chunk 经常"半句话+半句话"——这是规则失效的信号
- 文档结构差（没有标题、段落混乱）

代价是预先要跑一次 embedding，索引时间会增加 20-50%。对于一次建索引、长期查询的场景值得，对于天天重建的场景就别上了。

## chunkSize 和 chunkOverlap 调参的经验数字

我跑过的几十个项目里，下面这张表覆盖了 95% 的初始选型：

| 文档类型 | chunkSize | chunkOverlap | 备注 |
|----------|-----------|-------------|------|
| 短文档（FAQ、规则条款） | 300-500 | 50-80 | 每条事实一个 chunk |
| 通用中文长文 | 500-700 | 80-120 | 段落级粒度 |
| 通用英文长文 | 800-1200 | 100-200 | 词密度低，chunk 可以大一点 |
| Markdown 技术文档 | 头切 + 600 二切 | 100 | 标题继承到 metadata |
| 代码文件 | 1200-1800 | 150 | 按函数/类切 |
| 法律/合同 | 400-600 | 100 | 条款独立，重叠保住上下文 |
| 论文 / 综述 | 800-1000 + 语义切 | 100 | 话题切换多 |

`chunkOverlap` 推荐取 `chunkSize` 的 10-20%。0 重叠会切断跨块语义，重叠过大会重复浪费 token。

## 用真实数据跑一次对比

参数选完别拍脑袋上线，跑一次小规模实测。下面这段脚本对比四组参数对 Recall@k 的影响：

```typescript
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import type { Document } from "@langchain/core/documents";

interface EvalSample {
  question: string;
  expectedDocId: string; // 标准答案文档的 ID
}

async function evalConfig(
  docs: Document[],
  samples: EvalSample[],
  config: { chunkSize: number; chunkOverlap: number },
  k = 5
): Promise<number> {
  const splitter = new RecursiveCharacterTextSplitter(config);
  const chunks = await splitter.splitDocuments(docs);
  const store = await MemoryVectorStore.fromDocuments(
    chunks,
    new OpenAIEmbeddings({ model: "text-embedding-3-large" })
  );

  let hit = 0;
  for (const sample of samples) {
    const found = await store.similaritySearch(sample.question, k);
    if (found.some((d) => d.metadata.docId === sample.expectedDocId)) hit++;
  }
  return hit / samples.length;
}

const configs = [
  { chunkSize: 400, chunkOverlap: 50 },
  { chunkSize: 600, chunkOverlap: 100 },
  { chunkSize: 800, chunkOverlap: 120 },
  { chunkSize: 1200, chunkOverlap: 200 },
];

for (const cfg of configs) {
  const recall = await evalConfig(docs, samples, cfg);
  console.log(
    `chunkSize=${cfg.chunkSize}, overlap=${cfg.chunkOverlap}: Recall@5 = ${(
      recall * 100
    ).toFixed(1)}%`
  );
}
```

只需要 30-50 条标注样本就能跑出有意义的趋势。我手上的经验：同一份语料，最差配置和最好配置 Recall@5 能差 15-25 个百分点。这就是调参的 ROI。

## 分块后的质量检查

切完别急着入库，过一遍这几个 sanity check：

```typescript
import { Document } from "@langchain/core/documents";

interface ChunkQualityReport {
  total: number;
  empty: number;
  tooShort: number;
  tooLong: number;
  missingMetadata: number;
}

function audit(chunks: Document[], minLen = 80, maxLen = 2000): ChunkQualityReport {
  const report: ChunkQualityReport = {
    total: chunks.length,
    empty: 0,
    tooShort: 0,
    tooLong: 0,
    missingMetadata: 0,
  };

  for (const c of chunks) {
    const len = c.pageContent.trim().length;
    if (len === 0) report.empty++;
    else if (len < minLen) report.tooShort++;
    else if (len > maxLen) report.tooLong++;
    if (!c.metadata.source) report.missingMetadata++;
  }

  console.table(report);
  return report;
}
```

实战经验：

- **空 chunk** 通常是 splitter 没去掉只有标题的段落，回去检查 separator 配置
- **过短 chunk**（< 80 字符）大概率是孤立标题/列表项，可以合并到相邻 chunk
- **过长 chunk** 是 splitter 的最后兜底（按字符强切）触发了，要么 chunkSize 调大、要么补 separator

## 小结

分块是 RAG 调优 ROI 最高的环节。默认从 `RecursiveCharacterTextSplitter` 起步，中文 500/80、英文 800/120 是稳妥的初始参数。Markdown 文档必上 `MarkdownHeaderTextSplitter` + 二次切分，把标题层级写进 metadata。token 预算紧的场景用 `TokenTextSplitter`。长篇叙述类文档考虑语义分块。

参数定下来前用真实样本跑 Recall 对比，差几个百分点的事别拍脑袋。下一节 [Retriever 策略](./04-retrievers.md) 进入检索环节，看怎么把切好的 chunk 用得更准。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
