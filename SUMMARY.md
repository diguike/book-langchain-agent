# 完整目录

## 00 导论

- [前言](./00-introduction/00-preface.md)
- [课程路线图](./00-introduction/01-roadmap.md)
- [前置知识清单](./00-introduction/02-prerequisites.md)
- [环境搭建指南](./00-introduction/03-setup.md)

## 01 核心抽象

- [Runnable 接口详解](./01-core-abstractions/01-runnable-interface.md)
- [LCEL 表达式语言](./01-core-abstractions/02-lcel.md)
- [Model I/O](./01-core-abstractions/03-model-io.md)
- [Prompt Templates](./01-core-abstractions/04-prompt-templates.md)
- [Output Parsers](./01-core-abstractions/05-output-parsers.md)

## 02 Chain 组合

- [RunnableSequence](./02-chain-composition/01-runnable-sequence.md)
- [RunnableParallel](./02-chain-composition/02-runnable-parallel.md)
- [RunnableBranch](./02-chain-composition/03-runnable-branch.md)
- [Streaming 流式输出](./02-chain-composition/04-streaming.md)
- [Fallback 与重试](./02-chain-composition/05-fallback-retry.md)
- [LCEL vs LangGraph 决策指南](./02-chain-composition/06-lcel-vs-langgraph.md)

## 03 记忆系统

- [Memory 架构总览](./03-memory/01-memory-overview.md)
- [Buffer Memory](./03-memory/02-buffer-memory.md)
- [Summary Memory](./03-memory/03-summary-memory.md)
- [VectorStore Memory](./03-memory/04-vectorstore-memory.md)
- [自定义 MessageHistory 后端](./03-memory/05-custom-message-history.md)
- [多用户记忆隔离](./03-memory/06-multi-user-isolation.md)

## 04 工具与函数调用

- [Tool 接口与定义](./04-tools/01-tool-interface.md)
- [自定义 Tool 开发](./04-tools/02-custom-tool.md)
- [Function Calling 跨模型统一](./04-tools/03-function-calling.md)
- [MCP Server 集成](./04-tools/04-mcp-server.md)
- [外部系统集成模式](./04-tools/05-external-integration.md)

## 05 Agent 架构

- [createAgent 入门](./05-agent-architecture/01-create-agent.md)
- [ReAct 模式](./05-agent-architecture/02-react-pattern.md)
- [LangGraph 入门](./05-agent-architecture/03-langgraph-intro.md)
- [LangGraph State 与 Checkpointer](./05-agent-architecture/04-langgraph-state.md)
- [Plan and Execute](./05-agent-architecture/05-plan-and-execute.md)
- [Self-Reflection](./05-agent-architecture/06-self-reflection.md)
- [Middleware 系统](./05-agent-architecture/07-middleware.md)
- [Multi-Agent 协作](./05-agent-architecture/08-multi-agent.md)
- [Human-in-the-Loop 与 typed interrupt](./05-agent-architecture/09-human-in-the-loop.md)
- [流式输出深入 Stream Modes 与 Events](./05-agent-architecture/10-stream-modes.md)

## 06 RAG

- [RAG 基础管线](./06-rag/01-rag-pipeline.md)
- [Document Loaders](./06-rag/02-document-loaders.md)
- [Text Splitters](./06-rag/03-text-splitters.md)
- [Retriever 策略](./06-rag/04-retrievers.md)
- [高级 RAG 技术](./06-rag/05-advanced-rag.md)
- [RAG Agent](./06-rag/06-rag-agent.md)

## 07 可观测性与评估

- [Callback 系统](./07-observability/01-callbacks.md)
- [LangSmith Tracing](./07-observability/02-langsmith-tracing.md)
- [评估方法与指标](./07-observability/03-evaluation.md)
- [Prompt 工程优化](./07-observability/04-prompt-engineering.md)

## 08 生产部署

- [API 服务化](./08-production/01-api-server.md)
- [流式接口 SSE / WebSocket](./08-production/02-streaming-api.md)
- [缓存与成本优化](./08-production/03-caching-cost.md)
- [安全防御](./08-production/04-security.md)
- [部署架构](./08-production/05-deployment-architecture.md)

## 09 综合项目

- [智能客服 Agent](./09-projects/01-customer-service.md)
- [代码助手 Agent](./09-projects/02-code-assistant.md)
- [数据分析 Agent](./09-projects/03-data-analysis.md)
- [多 Agent 工作流平台](./09-projects/04-multi-agent-platform.md)

## 附录

- [术语表](./appendix/01-glossary.md)
- [API 速查表](./appendix/02-api-cheatsheet.md)
- [常见错误与排查](./appendix/03-troubleshooting.md)
- [推荐资源与社区](./appendix/04-resources.md)
