---
title: Document Loaders
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/XJYtw6sKHiI7W2kA1KtcQK9ln2g"
last_synced: "2026-05-25T02:42:35+08:00"
---

> 模块 06 - RAG | 前置知识：[RAG 基础管线](./01-rag-pipeline.md)

## 数据进来的瞬间，命运就决定了

我见过最离谱的一个 RAG 项目：用了 reranker、用了 HyDE、用了 hybrid search，调了三周准确率上不去 60%。最后查源头，PDF loader 把表格全压成了一行文字、目录页也当成正文塞进去了。脏数据不解决，下游再花哨也是白搭。

Document Loader 是 RAG 管线的第一环，它做两件事：

1. 把任意格式的源（PDF、Markdown、网页、Notion）变成统一的 `Document` 对象
2. 顺手把 metadata（来源、页码、作者、章节）挂上去，供后续 metadata filter 用

第一件事大部分 Loader 都能做。第二件事——metadata 设计——才是 Loader 章节真正要教的东西。LangChain.js 的 Loader 全集索引在 [官方文档](https://docs.langchain.com/oss/javascript/integrations/document_loaders/)，我这章只挑生产里真正用得多的讲。

## Document 对象到底长什么样

所有 Loader 输出都是 `Document[]`，看清这个结构再往下读：

```typescript
import { Document } from "@langchain/core/documents";

const doc = new Document({
  // 参与 embedding 和检索的文本
  pageContent: "VIP 用户的退货时限延长至 14 天。",

  // 不参与语义检索，但能用来过滤、溯源、展示
  metadata: {
    source: "policies/return-policy.pdf",
    page: 3,
    section: "VIP 政策",
    author: "客服部",
    updatedAt: "2026-04-01",
    docType: "policy",
    lang: "zh",
  },
});
```

记住：

- `pageContent` 决定能不能"召回"
- `metadata` 决定能不能"过滤"和"溯源"
- 两者都不可省

## Metadata Schema：被 90% 的人忽视的关键设计

直接抄一段我现在每个项目都用的 metadata 模板：

```typescript
interface RAGMetadata {
  // 溯源类（强烈建议必填）
  source: string;            // 原始文件路径或 URL
  docId: string;             // 业务侧文档唯一 ID
  updatedAt: string;         // ISO 时间戳，过期文档过滤用

  // 定位类（影响展示）
  page?: number;             // PDF 页码
  section?: string;          // 章节标题（Markdown / 网页）
  url?: string;              // 原始 URL（用于点击跳转）

  // 业务类（影响 retrieval 过滤）
  docType: "policy" | "faq" | "manual" | "changelog" | "wiki";
  category?: string;         // 业务分类
  audience?: "internal" | "customer" | "partner";
  lang?: "zh" | "en";

  // 权限类（多租户场景必备）
  tenantId?: string;
  permission?: "public" | "internal" | "confidential";
}
```

这个 schema 解决三类问题：

- **检索过滤**：用户问"最近的产品更新"，可以 `filter: { docType: "changelog", updatedAt: { $gte: "2026-04-01" } }`
- **多租户隔离**：不同租户数据用 `tenantId` 隔开，同一个向量库服务多客户
- **可观测**：日志里能直接看到答案出自哪个文档的第几页，运营和测试都需要

后面 [Retriever 策略](./04-retrievers.md) 章节展示的 metadata filter 全部依赖这套 schema。建议在 Loader 阶段就把它做对，后期补补丁很痛苦。

## 文件类 Loader：从最常见的入手

### PDF：用 unstructured 或 Docling 替代 pdf-parse

老牌 `PDFLoader` 用 `pdf-parse` 解析，碰上有表格、多栏、扫描件的 PDF 基本投降。生产环境我推荐两个现代方案：

**unstructured**（[unstructured.io](https://unstructured.io/)）：能识别标题/段落/表格/列表的结构化解析，输出带 element type 的 chunk。它本身是 Python 写的服务，LangChain 提供 client。

```bash
# 启动 unstructured 本地服务
docker run -p 8000:8000 -d --name unstructured-api \
  downloads.unstructured.io/unstructured-io/unstructured-api:latest

npm install @langchain/community
```

```typescript
import { UnstructuredLoader } from "@langchain/community/document_loaders/fs/unstructured";

const loader = new UnstructuredLoader("./contract.pdf", {
  apiUrl: "http://localhost:8000/general/v0/general",
  strategy: "hi_res", // 启用版面分析，识别表格和标题
});

const docs = await loader.load();
// 每个 Document 的 metadata.category 标了 element 类型
// "Title" / "NarrativeText" / "Table" / "ListItem" 等
docs.forEach((d) => {
  console.log(d.metadata.category, "::", d.pageContent.slice(0, 60));
});
```

拿到 element type 后，下游可以决定怎么处理：表格保留原样不切块、标题作为 section metadata、正文按段落切。

**Docling**（[Docling 项目](https://github.com/docling-project/docling)）：IBM 开源的文档解析器，重点强化了 PDF 表格还原。同样是 Python 服务，可以通过 HTTP 调用，或者在 Node 里 spawn 子进程。生产环境如果 PDF 表格多，Docling 比 unstructured 更稳。

```typescript
import { spawn } from "node:child_process";
import { Document } from "@langchain/core/documents";

async function loadWithDocling(pdfPath: string): Promise<Document[]> {
  // 假设你装了 docling CLI: pip install docling
  return new Promise((resolve, reject) => {
    const proc = spawn("docling", [pdfPath, "--output-format", "json"]);
    let buf = "";
    proc.stdout.on("data", (c) => (buf += c));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("docling failed"));
      const parsed = JSON.parse(buf);
      const docs = parsed.elements.map(
        (el: { text: string; type: string; page: number }) =>
          new Document({
            pageContent: el.text,
            metadata: {
              source: pdfPath,
              page: el.page,
              elementType: el.type,
            },
          })
      );
      resolve(docs);
    });
  });
}
```

如果不想自己跑解析服务，简单 PDF 仍然可以用社区的 `PDFLoader`：

```typescript
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";

const loader = new PDFLoader("./report.pdf", { splitPages: true });
const docs = await loader.load();
// docs[i].metadata.loc.pageNumber 是页码
```

### Markdown：尽量保留结构

Markdown 直接当文本读就丢掉了标题层级。两种正确姿势：

1. 加载时用 `TextLoader`，**Split 时**用 `MarkdownHeaderTextSplitter` 提取标题为 metadata（见 [Text Splitters](./03-text-splitters.md)）
2. 加载阶段就把 frontmatter 拆出来作为 metadata

下面演示第 2 种：

```typescript
import { TextLoader } from "langchain/document_loaders/fs/text";
import matter from "gray-matter";
import { Document } from "@langchain/core/documents";

async function loadMarkdownWithFrontmatter(filePath: string): Promise<Document[]> {
  const raw = await new TextLoader(filePath).load();
  const { data, content } = matter(raw[0].pageContent);
  return [
    new Document({
      pageContent: content,
      metadata: {
        source: filePath,
        ...data, // title / tags / author 等全进来
        docType: "wiki",
      },
    }),
  ];
}
```

### DOCX：mammoth 转 HTML 再清洗

`@langchain/community` 的 DOCX loader 基于 mammoth：

```typescript
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";

const loader = new DocxLoader("./spec.docx");
const docs = await loader.load();
```

DOCX 里如果有图、批注、修订记录，用 mammoth 的 raw 模式自己处理更可控。这部分超出 LangChain 范围，按需查 mammoth 文档。

### HTML：先抽正文再丢给 RAG

网页里 95% 的字符是导航、广告、页脚，全索引进去会污染检索。两种过滤策略：

**轻量场景用 CheerioWebBaseLoader + 选择器**：

```typescript
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";

const loader = new CheerioWebBaseLoader(
  "https://docs.langchain.com/oss/javascript/langchain/agents",
  {
    selector: "article", // 只抓 article 标签里的内容
  }
);
const docs = await loader.load();
```

**复杂场景用 Mozilla Readability 做正文抽取**：

```typescript
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { Document } from "@langchain/core/documents";

async function loadArticle(url: string): Promise<Document> {
  const html = await fetch(url).then((r) => r.text());
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article) throw new Error("无法解析正文");

  return new Document({
    pageContent: article.textContent,
    metadata: {
      source: url,
      title: article.title,
      author: article.byline ?? "",
      excerpt: article.excerpt,
      docType: "web",
    },
  });
}
```

Readability 是 Firefox 阅读模式底层的同一套算法，对博客、新闻、文档站正文抽取效果稳定。

### Notion / Confluence / 飞书 Wiki：用官方 API

SaaS 知识库别去爬 HTML，直接走 API。LangChain.js 社区版有 Notion 和 Confluence loader：

```typescript
import { NotionDBLoader } from "@langchain/community/document_loaders/web/notiondb";

const loader = new NotionDBLoader({
  databaseId: process.env.NOTION_DATABASE_ID!,
  notionIntegrationToken: process.env.NOTION_TOKEN!,
  pageSizeLimit: 100,
});
const docs = await loader.load();
// 每个 Notion page 一个 Document，metadata 自动带 properties
```

```typescript
import { ConfluencePagesLoader } from "@langchain/community/document_loaders/web/confluence";

const loader = new ConfluencePagesLoader({
  baseUrl: "https://your-org.atlassian.net/wiki",
  spaceKey: "ENG",
  username: process.env.CONFLUENCE_USER!,
  accessToken: process.env.CONFLUENCE_TOKEN!,
});
const docs = await loader.load();
```

飞书 Wiki 官方没出 loader，但我自己封过一个走 `lark-cli` 的版本，思路就是用 `BaseDocumentLoader` 包一层 API 调用。下一节会讲怎么写自定义 Loader。

### 整站抓取：RecursiveUrlLoader 配 sitemap

爬整个文档站，优先用 sitemap.xml 拿 URL 列表，然后逐个抓：

```typescript
import { RecursiveUrlLoader } from "@langchain/community/document_loaders/web/recursive_url";
import { compile } from "html-to-text";

const htmlToText = compile({ wordwrap: 130 });

const loader = new RecursiveUrlLoader("https://docs.example.com", {
  maxDepth: 3,
  excludeDirs: ["/api/", "/changelog/"],
  extractor: htmlToText,
});
const docs = await loader.load();
console.log(`抓了 ${docs.length} 个页面`);
```

注意 `maxDepth` 别开太大，3 层已经够覆盖大部分文档站。开到 5 层很容易陷进相对链接循环。

## 自定义 Loader：业务源接进来

内置 Loader 覆盖不了的源（自家数据库、内部 CMS、飞书 Wiki），自己继承 `BaseDocumentLoader`：

```typescript
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { Document } from "@langchain/core/documents";

interface FaqRow {
  id: string;
  question: string;
  answer: string;
  category: string;
  updatedAt: string;
}

class FaqDatabaseLoader extends BaseDocumentLoader {
  constructor(
    private fetcher: () => Promise<FaqRow[]>,
    private tenantId: string
  ) {
    super();
  }

  async load(): Promise<Document[]> {
    const rows = await this.fetcher();
    return rows.map(
      (row) =>
        new Document({
          // 问题和答案一起做 embedding，召回率比只 embed 答案高得多
          pageContent: `问题: ${row.question}\n答案: ${row.answer}`,
          metadata: {
            source: `faq://${row.id}`,
            docId: row.id,
            docType: "faq",
            category: row.category,
            updatedAt: row.updatedAt,
            tenantId: this.tenantId,
          },
        })
    );
  }
}

// 使用
const loader = new FaqDatabaseLoader(
  () => db.faq.findMany({ where: { tenantId: "acme" } }),
  "acme"
);
const faqDocs = await loader.load();
```

两个细节：

- **`pageContent` 不必只放答案**。把问题也拼进去，用户用类似措辞提问时召回率会显著提高
- **`source` 字段可以编造一个 URI 风格的标识**（`faq://xxx`、`wiki://yyy`），方便后续在前端做溯源路由

## 多源混合加载

真实知识库通常包含多种格式。`DirectoryLoader` 能按扩展名自动派发：

```typescript
import { DirectoryLoader } from "langchain/document_loaders/fs/directory";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";

const loader = new DirectoryLoader("./knowledge-base", {
  ".txt": (p) => new TextLoader(p),
  ".md": (p) => new TextLoader(p),
  ".pdf": (p) => new PDFLoader(p),
  ".docx": (p) => new DocxLoader(p),
});
const docs = await loader.load();
```

但 `DirectoryLoader` 没法给不同来源打不同 metadata。更可控的写法是显式组合：

```typescript
async function loadKnowledgeBase(): Promise<Document[]> {
  const all: Document[] = [];

  // 产品手册
  const manuals = await new PDFLoader("./docs/manual.pdf").load();
  manuals.forEach((d) => {
    d.metadata.docType = "manual";
    d.metadata.audience = "customer";
  });
  all.push(...manuals);

  // 内部 wiki
  const wikis = await new DirectoryLoader("./wiki", {
    ".md": (p) => new TextLoader(p),
  }).load();
  wikis.forEach((d) => {
    d.metadata.docType = "wiki";
    d.metadata.audience = "internal";
  });
  all.push(...wikis);

  // FAQ 数据库
  const faqs = await new FaqDatabaseLoader(loadFaqs, "default").load();
  all.push(...faqs);

  console.log(`共 ${all.length} 个 Document`);
  return all;
}
```

加载后做一次 metadata 完整性检查：

```typescript
function assertMetadata(docs: Document[]): void {
  const required = ["source", "docType"];
  const missing: string[] = [];
  for (const [i, d] of docs.entries()) {
    for (const key of required) {
      if (!d.metadata[key]) missing.push(`#${i}: 缺 ${key}`);
    }
  }
  if (missing.length) {
    console.warn("metadata 不完整:", missing.slice(0, 10));
    throw new Error(`${missing.length} 个文档缺必填 metadata`);
  }
}

assertMetadata(await loadKnowledgeBase());
```

这一步看着啰嗦，但能在入库前拦住一类常见 bug——某批数据 metadata 缺失导致后续 filter 全部失效。

## Loader 选型小抄

| 数据源 | 推荐 Loader | 备注 |
|--------|-------------|------|
| 结构化 PDF（表格多） | unstructured / Docling | 自建解析服务，最准 |
| 简单 PDF | `PDFLoader` | 够用，依赖最少 |
| Markdown | `TextLoader` + frontmatter 解析 | 拿到标题层级再丢给 Splitter |
| DOCX | `DocxLoader`（mammoth） | 复杂格式自己后处理 |
| 静态网页 | `CheerioWebBaseLoader` + 选择器 | 轻量 |
| 文章正文抽取 | Mozilla Readability | 抽取质量最高 |
| 动态网页 | `PuppeteerWebBaseLoader` | 慢且重，能不用就不用 |
| 整站 | `RecursiveUrlLoader` + sitemap | 控制好 maxDepth |
| Notion | `NotionDBLoader` | 走官方 API |
| Confluence | `ConfluencePagesLoader` | 走官方 API |
| GitHub 代码 | `GithubRepoLoader` | 注意忽略 lock 文件 |
| 内部数据库 | 自定义 `BaseDocumentLoader` | 顺手把 metadata 设计做对 |

## 小结

Loader 决定了知识进 RAG 时的样子，做对两件事就够了：把异构源变成 `Document`，把 metadata schema 设计成业务能用的形状。生产环境优先用 unstructured / Docling 处理 PDF、用 Readability 抽网页正文、用官方 API 接 SaaS。自定义源就继承 `BaseDocumentLoader`，顺手把 source / docType / updatedAt / tenantId 这些核心字段填齐。

下一节 [Text Splitters](./03-text-splitters.md) 讲怎么把这些 Document 切成大小合适的 chunk——分块策略直接决定召回率，是 RAG 调优最划算的环节。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
