---
title: 推荐资源与社区
feishu_url: ""
last_synced: ""
---

> 这一章给的是我自己在写这本书的过程中实际反复查、反复看的资源。不堆"清单"，每个都标一下"什么时候该来这里"。

## LangChain 官方

| 资源 | 链接 | 什么时候用 |
|------|------|----------|
| 文档主站 | <https://docs.langchain.com> | 1.x 的所有概念、API 都在这里，第一目的地 |
| LangChain.js GitHub | <https://github.com/langchain-ai/langchainjs> | 看源码、提 issue、追 PR |
| LangGraph.js 文档 | <https://langchain-ai.github.io/langgraphjs/> | LangGraph 的 StateGraph / Channels / typed interrupt 等细节 |
| LangSmith | <https://smith.langchain.com/> | Tracing、评估、Prompt Hub 都在这 |
| Changelog | <https://docs.langchain.com/oss/javascript/releases/changelog> | 1.x 后版本变化频繁，发版时来这看 |
| Blog | <https://blog.langchain.dev> | 新功能解读、最佳实践案例 |
| Discord | <https://discord.gg/langchain> | 比 GitHub issue 更快得到回复 |
| 主站介绍 | <https://www.langchain.com/> | 给非工程同事看的产品视角 |

## 本书相关

| 资源 | 链接 | 说明 |
|------|------|------|
| 本书 GitHub 仓库 | <https://github.com/diguike/book-langchain-agent> | 全书 Markdown 源文件 + 示例代码 |
| 作者站点 | <https://inferloop.dev> | 本书在线版 + 我写的其他书 |
| 飞书 Wiki | 见站点导航 | 中文阅读体验最好的版本 |

发现书里有错或者有更好的实现，欢迎到 GitHub 仓库提 issue 或 PR。

## LLM provider 官方文档

写 Agent 跑通了之后，下一步是把模型用透。每家 provider 自己的文档比 LangChain 的更细，特别是关于工具调用的参数细节、推理模式、缓存机制。

| Provider | 文档 | 模型亮点 |
|----------|------|---------|
| Anthropic | <https://www.anthropic.com/> | Claude Opus 4.7（推理旗舰）/ Sonnet 4.6（平衡）/ Haiku 4.5（速度）。extended thinking 模式特别适合复杂规划任务 |
| OpenAI | <https://openai.com/> | GPT-5 系列（推理） / GPT-4o（多模态） / GPT-4o-mini（成本敏感场景） |
| Google | <https://ai.google.dev/> | Gemini，长上下文窗口（1M+ tokens）和多模态能力强 |
| DeepSeek | <https://www.deepseek.com/> | 国产开源旗舰，价格远低于头部商业模型 |
| Moonshot Kimi | <https://www.moonshot.cn/> | 国产长上下文场景表现稳定 |
| 阿里通义 | <https://tongyi.aliyun.com/> | 国产电商 / 政企场景集成方便 |

## 互补框架与工具

LangChain.js 不是 Agent 开发的唯一选择，了解周边生态才能在真实项目里选型：

| 工具 / 框架 | 定位 | 链接 |
|------------|------|------|
| Vercel AI SDK | 偏前端、流式 UI 友好，和 Next.js 集成丝滑 | <https://sdk.vercel.ai/> |
| LlamaIndex.TS | 专注 RAG，索引和检索的抽象更细 | <https://ts.llamaindex.ai/> |
| AutoGen | 微软的多 Agent 协作框架（Python 为主） | <https://github.com/microsoft/autogen> |
| CrewAI | 角色化多 Agent 编排 | <https://crewai.com> |
| Hono | 本书 API 层默认 web 框架 | <https://hono.dev/> |
| Zod | TypeScript schema 验证库，工具参数定义必备 | <https://zod.dev/> |
| MCP | Anthropic 推出的工具/数据源接入协议 | <https://modelcontextprotocol.io/> |

向量数据库：

| 产品 | 特点 |
|------|------|
| PGVector | PostgreSQL 扩展，部署简单，本书示例默认 |
| Pinecone | 全托管 SaaS，免运维 |
| Qdrant | Rust 写的高性能开源 |
| Weaviate | 开源、自带 hybrid search |
| Chroma | 轻量，适合本地原型 |

## 经典论文

工程师不需要把论文从头啃完，但读过下面这几篇会让你看 Agent 实现时少很多"为什么这么写"的困惑：

| 论文 | 关键贡献 | 链接 |
|------|---------|------|
| ReAct: Synergizing Reasoning and Acting in Language Models | Agent 的"思考-行动-观察"循环 | <https://arxiv.org/abs/2210.03629> |
| Plan-and-Solve Prompting | 先规划再分步执行的 Agent 模式 | <https://arxiv.org/abs/2305.04091> |
| Reflexion: Language Agents with Verbal Reinforcement Learning | Agent 自我反思修正 | <https://arxiv.org/abs/2303.11366> |
| Toolformer: Language Models Can Teach Themselves to Use Tools | 工具调用能力的训练范式 | <https://arxiv.org/abs/2302.04761> |
| Chain-of-Thought Prompting | 思维链 prompt 的奠基论文 | <https://arxiv.org/abs/2201.11903> |
| Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks | RAG 的奠基论文 | <https://arxiv.org/abs/2005.11401> |
| Self-Consistency Improves Chain of Thought | 多次采样投票提升推理质量 | <https://arxiv.org/abs/2203.11171> |

## 推荐博客

写 Agent 的人值得长期关注：

| 来源 | 链接 | 内容 |
|------|------|------|
| LangChain Blog | <https://blog.langchain.dev> | 官方第一手 |
| Lilian Weng's Blog | <https://lilianweng.github.io> | OpenAI 研究员，Agent / RAG 深度长文 |
| Simon Willison | <https://simonwillison.net> | LLM 实践派，他怎么用工具就怎么记录 |
| Anthropic Engineering | <https://www.anthropic.com/engineering> | Anthropic 自己怎么做 Agent（特别是 Claude Code 系列文章） |
| Hugging Face Blog | <https://huggingface.co/blog> | 开源生态动态 |

## 怎么跟上 LangChain.js 的版本节奏

LangChain.js 在 1.x 之后版本号迭代依旧快。我自己的做法：

1. 把 [Changelog](https://docs.langchain.com/oss/javascript/releases/changelog) 加到 RSS 阅读器，每发新版本扫一眼 breaking changes
2. 每月在 CI 里跑一次 `npm outdated`，主动决定要不要升
3. 关键依赖锁住 minor 版本（`^1.4.0` 而不是 `*`），避免半夜 build 挂掉
4. Watch `langchain-ai/langchainjs` 仓库的 Releases（不要全 Watch，noise 太大）

## 遇到问题怎么提问

按顺序试：

1. 查 [文档主站](https://docs.langchain.com/)，1.x 后文档质量大幅提升
2. 搜 [GitHub Issues](https://github.com/langchain-ai/langchainjs/issues)，加上 `is:closed` 看历史解答
3. 去 Discord 的 `#langchainjs-help` 频道贴最小复现代码 + 错误堆栈 + 版本号
4. 实在无果再开新 issue，记得带：
   - `langchain` / `@langchain/core` / `@langchain/langgraph` 版本
   - Node.js 版本
   - 最小可复现代码（精简到 20-30 行）
   - 完整错误堆栈

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
