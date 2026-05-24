# 完整目录

## 00 导论

- [前言](./00-introduction/preface.md)
- [课程路线图](./00-introduction/roadmap.md)
- [前置知识清单](./00-introduction/prerequisites.md)
- [环境搭建指南](./00-introduction/setup.md)

## 01 核心抽象

- [Runnable 接口详解](./01-core-abstractions/runnable-interface.md)
- [LCEL 表达式语言](./01-core-abstractions/lcel.md)
- [Model I/O](./01-core-abstractions/model-io.md)
- [Prompt Templates](./01-core-abstractions/prompt-templates.md)
- [Output Parsers](./01-core-abstractions/output-parsers.md)

## 02 Chain 组合

- [RunnableSequence](./02-chain-composition/runnable-sequence.md)
- [RunnableParallel](./02-chain-composition/runnable-parallel.md)
- [RunnableBranch](./02-chain-composition/runnable-branch.md)
- [Streaming 流式输出](./02-chain-composition/streaming.md)
- [Fallback 与重试](./02-chain-composition/fallback-retry.md)
- [LCEL vs LangGraph 决策指南](./02-chain-composition/lcel-vs-langgraph.md)

## 03 记忆系统

- [Memory 架构总览](./03-memory/memory-overview.md)
- [Buffer Memory](./03-memory/buffer-memory.md)
- [Summary Memory](./03-memory/summary-memory.md)
- [VectorStore Memory](./03-memory/vectorstore-memory.md)
- [自定义 MessageHistory 后端](./03-memory/custom-message-history.md)
- [多用户记忆隔离](./03-memory/multi-user-isolation.md)

## 04 工具与函数调用

- [Tool 接口与定义](./04-tools/tool-interface.md)
- [自定义 Tool 开发](./04-tools/custom-tool.md)
- [Function Calling 跨模型统一](./04-tools/function-calling.md)
- [MCP Server 集成](./04-tools/mcp-server.md)
- [外部系统集成模式](./04-tools/external-integration.md)

## 05 Agent 架构

- [createAgent 入门](./05-agent-architecture/create-agent.md)
- [ReAct 模式](./05-agent-architecture/react-pattern.md)
- [LangGraph 入门](./05-agent-architecture/langgraph-intro.md)
- [LangGraph State 与 Checkpointer](./05-agent-architecture/langgraph-state.md)
- [Plan and Execute](./05-agent-architecture/plan-and-execute.md)
- [Self-Reflection](./05-agent-architecture/self-reflection.md)
- [Middleware 系统](./05-agent-architecture/middleware.md)
- [Multi-Agent 协作](./05-agent-architecture/multi-agent.md)
- [Human-in-the-Loop 与 typed interrupt](./05-agent-architecture/human-in-the-loop.md)
- [流式输出深入 Stream Modes 与 Events](./05-agent-architecture/stream-modes.md)

## 06 RAG

- [RAG 基础管线](./06-rag/rag-pipeline.md)
- [Document Loaders](./06-rag/document-loaders.md)
- [Text Splitters](./06-rag/text-splitters.md)
- [Retriever 策略](./06-rag/retrievers.md)
- [高级 RAG 技术](./06-rag/advanced-rag.md)
- [RAG Agent](./06-rag/rag-agent.md)

## 07 可观测性与评估

- [Callback 系统](./07-observability/callbacks.md)
- [LangSmith Tracing](./07-observability/langsmith-tracing.md)
- [评估方法与指标](./07-observability/evaluation.md)
- [Prompt 工程优化](./07-observability/prompt-engineering.md)

## 08 生产部署

- [API 服务化](./08-production/api-server.md)
- [流式接口 SSE / WebSocket](./08-production/streaming-api.md)
- [缓存与成本优化](./08-production/caching-cost.md)
- [安全防御](./08-production/security.md)
- [部署架构](./08-production/deployment-architecture.md)

## 09 综合项目

- [智能客服 Agent](./09-projects/customer-service.md)
- [代码助手 Agent](./09-projects/code-assistant.md)
- [数据分析 Agent](./09-projects/data-analysis.md)
- [多 Agent 工作流平台](./09-projects/multi-agent-platform.md)

## 附录

- [术语表](./appendix/glossary.md)
- [API 速查表](./appendix/api-cheatsheet.md)
- [常见错误与排查](./appendix/troubleshooting.md)
- [推荐资源与社区](./appendix/resources.md)
