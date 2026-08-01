# LangChain.js Agent 开发权威指南

> 面向应用层工程师的 LangChain.js 1.x 系统化教程。从 Runnable / LCEL 基础抽象，到 LangGraph 多 Agent 编排、RAG、可观测性、生产部署，一路把你带到能独立交付 AI Agent 产品的水平。

## 这本书是什么

- **目标读者**：有 1-2 年 TypeScript / Node.js 经验，想转型 AI Agent 工程的开发者；或者已经用过 LangChain Python，想迁移到 JS 生态的工程师。
- **覆盖范围**：LangChain.js 1.x 全套核心 API、LangGraph.js 状态机编排、Deep Agents、内置 Middleware、Supervisor / Swarm 多 Agent、RAG 工程化、LangSmith 可观测性与轨迹评估、生产部署与 LangGraph Platform、生成式前端。
- **不覆盖**：模型训练、微调、底层算法、Python LangChain（生态不同）。
- **基线版本**：`langchain@1.5` / `@langchain/langgraph@1.0` / `@langchain/core@1.2`。

建议从 [前言](./00-introduction/00-preface.md) 开始。

## 目录

**第一部分 · 基础**

- 00 导论：[前言](./00-introduction/00-preface.md) · [课程路线图](./00-introduction/01-roadmap.md) · [前置知识清单](./00-introduction/02-prerequisites.md) · [环境搭建指南](./00-introduction/03-setup.md)
- 01 核心抽象：[Runnable 接口](./01-core-abstractions/01-runnable-interface.md) · [LCEL](./01-core-abstractions/02-lcel.md) · [Model I/O 模型输入输出](./01-core-abstractions/03-model-io.md) · [Prompt Templates 提示词模板](./01-core-abstractions/04-prompt-templates.md) · [Output Parsers 输出解析器](./01-core-abstractions/05-output-parsers.md)
- 02 Chain 组合：[RunnableSequence 顺序链](./02-chain-composition/01-runnable-sequence.md) · [RunnableParallel 并行链](./02-chain-composition/02-runnable-parallel.md) · [RunnableBranch 条件分支](./02-chain-composition/03-runnable-branch.md) · [Streaming](./02-chain-composition/04-streaming.md) · [Fallback 与重试](./02-chain-composition/05-fallback-retry.md) · [LCEL vs LangGraph](./02-chain-composition/06-lcel-vs-langgraph.md)

**第二部分 · 记忆与工具**

- 03 记忆系统：[1.x 记忆系统](./03-memory/01-memory-overview.md) · [短期记忆 checkpointer](./03-memory/02-buffer-memory.md) · [Summary 压缩](./03-memory/03-summary-memory.md) · [VectorStore 记忆](./03-memory/04-vectorstore-memory.md) · [自定义后端](./03-memory/05-custom-message-history.md) · [多用户隔离](./03-memory/06-multi-user-isolation.md) · [长期记忆 Store 语义召回](./03-memory/07-long-term-store-semantic.md)
- 04 工具与函数调用：[Tool 接口](./04-tools/01-tool-interface.md) · [自定义 Tool](./04-tools/02-custom-tool.md) · [Function Calling](./04-tools/03-function-calling.md) · [MCP Server](./04-tools/04-mcp-server.md) · [外部系统集成](./04-tools/05-external-integration.md)

**第三部分 · Agent 架构（核心）**

- 05 Agent 架构：[createAgent 入门](./05-agent-architecture/01-create-agent.md) · [ReAct 模式](./05-agent-architecture/02-react-pattern.md) · [LangGraph 入门](./05-agent-architecture/03-langgraph-intro.md) · [State 与 Checkpointer](./05-agent-architecture/04-langgraph-state.md) · [Plan and Execute 规划-执行模式](./05-agent-architecture/05-plan-and-execute.md) · [Self-Reflection 自我反思模式](./05-agent-architecture/06-self-reflection.md) · [Middleware 系统](./05-agent-architecture/07-middleware.md) · [Multi-Agent 协作](./05-agent-architecture/08-multi-agent.md) · [Human-in-the-Loop](./05-agent-architecture/09-human-in-the-loop.md) · [Stream Modes](./05-agent-architecture/10-stream-modes.md) · [Deep Agents](./05-agent-architecture/11-deep-agents.md) · [内置 Middleware 全景](./05-agent-architecture/12-middleware-builtin.md) · [Supervisor](./05-agent-architecture/13-supervisor.md) · [Swarm](./05-agent-architecture/14-swarm.md)

**第四部分 · RAG 与可观测性**

- 06 RAG：[基础管线](./06-rag/01-rag-pipeline.md) · [Document Loaders 文档加载器](./06-rag/02-document-loaders.md) · [Text Splitters 文本切分](./06-rag/03-text-splitters.md) · [Retriever 策略](./06-rag/04-retrievers.md) · [高级 RAG](./06-rag/05-advanced-rag.md) · [RAG Agent](./06-rag/06-rag-agent.md)
- 07 可观测性与评估：[Callback 系统](./07-observability/01-callbacks.md) · [LangSmith Tracing](./07-observability/02-langsmith-tracing.md) · [评估方法与指标](./07-observability/03-evaluation.md) · [Prompt 工程优化](./07-observability/04-prompt-engineering.md) · [Agent 轨迹评估](./07-observability/05-agent-trajectory-eval.md)

**第五部分 · 生产与项目**

- 08 生产部署：[API 服务化](./08-production/01-api-server.md) · [流式接口部署](./08-production/02-streaming-api.md) · [缓存与成本](./08-production/03-caching-cost.md) · [安全防御](./08-production/04-security.md) · [部署架构](./08-production/05-deployment-architecture.md) · [LangGraph Platform 部署](./08-production/06-langgraph-platform.md)
- 09 综合项目：[智能客服](./09-projects/01-customer-service.md) · [代码助手](./09-projects/02-code-assistant.md) · [数据分析](./09-projects/03-data-analysis.md) · [多 Agent 平台](./09-projects/04-multi-agent-platform.md) · [深度调研 Agent](./09-projects/05-deep-research-agent.md)
- 10 前端集成：[生成式 UI 与 useStream](./10-frontend-ui/01-streaming-ui-usestream.md)

**附录**

- [术语表](./appendix/01-glossary.md) · [API 速查表](./appendix/02-api-cheatsheet.md) · [常见错误与排查](./appendix/03-troubleshooting.md) · [推荐资源与社区](./appendix/04-resources.md)

完整目录另见 [SUMMARY.md](./SUMMARY.md)。

## 在线阅读

- 飞书 Wiki：[fivwvysqdz.feishu.cn/wiki/YcWUwdyOeifpa7kmPgtcMTG9nSF](https://fivwvysqdz.feishu.cn/wiki/YcWUwdyOeifpa7kmPgtcMTG9nSF)
- inferloop 站点：https://inferloop.dev/langchain-agent

## 配套源码

各章可运行示例在 [`examples/`](./examples) 下，每个示例是独立的 `npm install && npm start` 小项目。

**没有 API key 也能跑**：`examples/_shared/mock-llm` 提供一个 OpenAI 协议兼容的本地服务，后端接你本机已登录的 Claude Code，示例默认指向它。详见 [examples/README.md](./examples/README.md)。

## 关于作者

[递归客](https://inferloop.dev) — Agent 工程师，全栈工程师出身，做 Agent 自进化、长程 Agent、AI 资产建设与团队 AI 体系搭建。inferloop.dev 站点维护者，技术书籍作者。

## 反馈

发现错误或想交流：在本仓库提 Issue。

## License

正文采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 授权（署名 · 非商业 · 相同方式共享）。配套示例代码采用 MIT 协议。
