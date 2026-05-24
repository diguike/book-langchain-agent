---
title: 前言
feishu_url: "https://www.feishu.cn/wiki/FI4uwojq3i004XkhQc4c2rUOneg"
last_synced: "2026-05-25T02:40:01+08:00"
---

## 为什么写这本书

去年某个深夜，我在 GitHub 上盯着 LangChain.js 的 README 翻了 20 多分钟，想搞清楚一个 Agent 如何把对话历史正确地持久化到 Postgres。文档里给的例子全是 Python，搜出来的中文博客有的还停留在两个大版本前的旧 API，有的是机翻 Python 教程后没改对的 JS 代码——直接 `pip install` 出现在了 npm 安装命令里。

那一刻我有点烦躁。Node.js 是 Web 后端最主流的运行时之一，TypeScript 是几乎所有现代前端项目的默认语言，但当工程师想用熟悉的语言进入 LLM 应用开发时，能找到的资料质量和数量都和 Python 生态差出至少一个数量级。LangChain.js 在 npm 上周下载量已经稳定突破六位数，可对应的中文教程依然零散、过时、错漏百出。

这本书就是写给那个夜里的我，以及所有处在类似困境里的 JS/TS 工程师。我把过去半年踩过的坑、走过的弯路、看过的源码、做过的项目，整理成一条尽量短的路径：让你从"听说过 LangChain"到"能独立交付一个生产级 AI Agent 产品"，中间不再需要去 Python 文档里翻译对照。

## 这本书写给谁

我假设你已经具备以下背景：

- 至少 1 年 TypeScript / Node.js 开发经验，熟悉 `async/await`、ES Module、`npm` 工作流
- 大致用过一次 OpenAI 或 Anthropic 的 SDK（知道 API Key 在哪儿、什么是 system prompt 就行）
- 看过几篇关于 LLM 的文章，理解 token、context window 这些基本概念

如果你是以下任一类型，这本书都会对你有用：

- **Node.js / 全栈工程师**：想把已有的 Web 工程能力延伸到 AI Agent 产品方向，但不想从头学一遍 Python 生态。
- **Python LangChain 用户**：因为业务需要迁移到 JS/TS 技术栈（比如要和 Next.js、Cloudflare Workers 集成），需要快速找到对应的 JS API。
- **AI 应用架构师 / 技术负责人**：需要评估 LangChain.js 在生产环境的工程取舍，理解 LangGraph 状态机、RAG 工程化、可观测性等关键决策。
- **AI 时代的内容创作者 / 独立开发者**：想从零搭一个真能上线的 Agent 产品，而不只是 Demo。

**这本书不适合谁**：

- **零基础编程学习者**：本书不教 JavaScript / TypeScript 基础语法，也不解释什么是 HTTP。
- **想学模型训练或微调的人**：本书是应用层教程，完全不涉及 PyTorch、Transformer 内部结构、SFT/RLHF 等话题。
- **追求"5 分钟搞定 AI Agent"的人**：这本书的目标是让你能独立把控生产环境的复杂度，每一章都会要求你动手跑代码、读源码、做权衡，不会有"复制粘贴就上线"的捷径。

## 这本书覆盖什么 / 不覆盖什么

**覆盖**：

- LangChain.js 1.x 的核心抽象：Runnable 接口、LCEL 表达式、Model I/O、Prompt Templates、Output Parsers
- Chain 组合的五种模式：顺序、并行、分支、流式、容错
- 三种记忆系统的工程实现（Buffer / Summary / VectorStore），以及多用户隔离的生产实践
- Tool 系统与 Function Calling 的跨模型统一，MCP（Model Context Protocol）集成
- Agent 架构全套：createAgent、ReAct、Plan-and-Execute、Self-Reflection、LangGraph 状态机、Middleware 系统、Multi-Agent 协作、Human-in-the-Loop
- RAG 全链路：Document Loaders、Text Splitters、Retriever 策略、高级 RAG（HyDE、Multi-Query、Re-ranking）、RAG Agent
- LangSmith 可观测性、评估方法与指标、Prompt 工程优化
- 生产部署：HTTP API、SSE / WebSocket 流式接口、缓存、成本优化、安全防御、部署架构
- 四个完整项目：智能客服、代码助手、数据分析、多 Agent 工作流平台

**不覆盖**：

- 模型训练、微调、量化、推理引擎（这些是《LLM Infra 工程实战》这本书的范畴）
- Python LangChain 的完整 API（生态、API 名称、约定都和 JS 不同）
- 前端 UI 开发（聊天界面 / 仪表盘等界面层不在范围内）
- 具体业务领域的 prompt 工程（如医疗、法律等垂直领域的提示词技巧）

## 怎么读这本书

我设计了三条阅读路径，请按自己的目标选择：

**路径 A：快速上手（约 1-2 周）**

适合需要尽快做出原型的人。

读完 `00 导论` → `01 核心抽象`（只读 Runnable 和 LCEL）→ `02 Chain 组合`（只读 RunnableSequence 和 Streaming）→ `04 工具与函数调用`（只读 Tool 接口和 Function Calling）→ `05 Agent 架构`（只读 createAgent 入门和 ReAct）→ `09 综合项目` 任选一个。

这条路径会让你在两周内拿出一个可演示的 Agent Demo，但生产化和工程细节需要回头补课。

**路径 B：系统学习（约 5-6 周）**

适合想系统掌握 LangChain.js 整套生态的工程师。

按目录顺序从 `00 导论` 读到 `09 综合项目`，每一篇都把示例代码跑一遍，每个模块结束时完成产出物。这是我自己学习 LangChain.js 时希望有的路径。

**路径 C：聚焦专项（按需翻阅）**

适合已经有 LangChain 基础、需要深入某个专题的工程师。

把这本书当成参考手册。需要做 RAG 时直接读 `06 RAG`，需要上生产时直接读 `08 生产部署`，需要做评估时直接读 `07 可观测性与评估`。每篇都尽量做到可独立阅读，跨章节依赖会在文中明确标注。

无论哪条路径，都强烈建议你**先读完前言后面的两篇**：[前置知识清单](./02-prerequisites.md) 帮你确认基础是否就绪，[环境搭建指南](./03-setup.md) 是后续所有代码示例的依赖。

## 配套资源

- **GitHub 仓库**：https://github.com/diguike/book-langchain-agent
- **在线阅读**：https://inferloop.dev/langchain-agent
- **作者主页与其他书籍**：https://inferloop.dev
- **勘误反馈**：在 GitHub 仓库提 Issue，或在阅读时直接评论飞书 Wiki

每一篇都附了对应章节的可运行示例，全部用 TypeScript + Node.js 22+ 编写，无需任何额外环境配置。每条 API 引用都会标注源码路径，方便你直接跳到 `@langchain/core` 源码对照阅读。

## 一句话

LangChain.js 生态还在快速演进，这本书会持续更新。如果你读到某一段觉得"这写得不对吧"，请相信你的判断——很可能是 1.x 的某个小版本又改了 API。请到 GitHub 上提 Issue，我会尽快跟进。

希望这本书能让你少踩一些我踩过的坑，把更多时间花在真正有价值的事情上：构建有用的 AI 产品。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
