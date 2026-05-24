---
title: 术语表
feishu_url: ""
last_synced: ""
---

> 全书出现的核心术语中英对照。每条术语标注首次出现的章节，方便回查上下文。

## 1.x 新引入的术语

这一组是 LangChain.js 1.x 才出现或被赋予新含义的概念，集中放在最前面：

| 术语 | 英文全称 / 写法 | 中文 | 一句话定义 | 首次出现 |
|------|----------------|------|------------|----------|
| **createAgent** | `createAgent` (from `langchain`) | 创建 Agent | 1.x 构建 Agent 的主入口函数，把模型、工具、系统提示拼成一张可运行的 LangGraph 图 | 05 createAgent 入门 |
| **Middleware** | `createMiddleware` / `dynamicSystemPromptMiddleware` 等 | 中间件 | 在 Agent 循环的 `beforeModel` / `afterModel` / `wrapToolCall` 等切面插入的逻辑钩子 | 05 Middleware 系统 |
| **ContentBlock** | `message.contentBlocks` | 内容块 | 统一不同 provider 多模态结构的消息块数组（文本块、图像块、思考块、工具调用块等） | 01 模型 IO |
| **toolStrategy** | `toolStrategy(schema)` | 工具策略 | `withStructuredOutput` 的结构化输出策略之一，让模型用工具调用方式产出结构化结果 | 01 Output Parsers |
| **providerStrategy** | `providerStrategy(schema)` | 原生策略 | 直接走 provider 原生结构化输出能力（如 OpenAI Strict JSON Mode） | 01 Output Parsers |
| **Annotation** | `Annotation.Root({ ... })` | 状态注解 | LangGraph 中定义 `State Schema` 的 API，每个字段可单独指定 reducer 和 default | 05 State、Channels |
| **Channel** | LangGraph Channel | 通道 | `State` 中每个字段对应一条 channel，定义其更新规则（reducer） | 05 State、Channels |
| **Checkpointer** | `MemorySaver` / `PostgresSaver` | 检查点存储 | LangGraph 持久化 `State` 的存储后端，按 `thread_id` 分线程保存 | 05 State、Channels |
| **typed interrupt** | `interrupts: { ... }` + `interrupt(...)` | 类型化中断 | 1.x 新的 HITL 中断 API，中断值带 TypeScript 类型，恢复时类型安全 | 05 Human-in-the-Loop |
| **Stream Mode** | `streamMode: "values" \| "updates" \| "messages" \| "debug" \| "custom"` | 流模式 | LangGraph 流式输出的粒度选择 | 05 流式输出深入 |
| **Reducer** | reducer function | 归约器 | Annotation 字段上的合并函数，决定新值如何并入旧值 | 05 State、Channels |
| **Supervisor / Worker** | Multi-Agent topology | 主管 / 工作者 | 多 Agent 协作模式：Supervisor 路由任务，Worker 执行专项任务 | 05 Multi-Agent |
| **`@langchain/classic`** | npm package | 经典 API 容身处 | 1.x 拆分出的 legacy API 包（如 `AgentExecutor` 等老组件），仅做兼容 | 00 路线图 |

## A

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Agent** | 智能体 | 能自主决定调什么工具、怎么完成任务的 LLM 应用 | 05 createAgent 入门 |
| **Agentic RAG** | 智能体增强检索 | 把检索过程交给 Agent 决策（是否检索、检索什么、怎么用） | 06 RAG Agent |
| **API Key** | API 密钥 | 认证 LLM provider 身份的密钥字符串 | 00 准备 |

## B

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Batch** | 批量 | 一次发多个请求并行处理 | 01 Runnable 接口 |
| **BaseChatModel** | 聊天模型基类 | LangChain 所有 Chat Model 的公共基类 | 01 模型 IO |

## C

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Callback** | 回调 | 在模型 / 工具 / Chain 关键节点插入的事件钩子（被 LangSmith Tracing 大量使用） | 07 可观测性 |
| **Chain** | 链 | 把多个 Runnable 通过 `.pipe()` 串联起来的执行管道 | 02 Chain 组合 |
| **Chain-of-Thought (CoT)** | 思维链 | 让模型先输出推理步骤再给结论的 prompt 技术 | 05 ReAct 模式 |
| **Chat Model** | 聊天模型 | 输入输出都是消息（`Message[]`）的 LLM | 01 模型 IO |
| **Checkpoint** | 检查点 | LangGraph 中 `State` 在某个时间点的快照 | 05 State、Channels |
| **Chunk** | 块 | 文档切分后的小段；流式输出中的数据片段 | 06 文本切分 |
| **Context Window** | 上下文窗口 | 模型单次能处理的最大 token 数 | 01 模型 IO |

## D

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Dataset** | 数据集 | LangSmith 中的输入-输出样本集合，用于评估 | 07 评估 |
| **Document** | 文档对象 | LangChain 中表示文本片段的对象 `{ pageContent, metadata }` | 06 文档加载 |
| **Document Loader** | 文档加载器 | 把 PDF / 网页 / 数据库等转成 `Document` 数组的组件 | 06 文档加载 |

## E

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Edge** | 边 | LangGraph 中连接两个节点、定义流转方向的连线 | 05 LangGraph 入门 |
| **Embedding** | 向量嵌入 | 把文本映射到一个高维实数向量，语义相似的文本距离相近 | 06 Embedding |
| **Evaluation** | 评估 | 系统化测量 LLM 应用输出质量的方法 | 07 评估 |

## F

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Faithfulness** | 忠实度 | RAG 评估指标：回答是否忠于检索到的上下文 | 07 评估 |
| **Fallback** | 兜底 | 主组件失败时自动切到备用组件 | 08 容错 |
| **Few-Shot Prompting** | 少样本提示 | prompt 里塞几个示例引导模型行为 | 01 Prompt |
| **Function Calling** | 函数调用 | 模型输出结构化函数参数（而不是自然语言），用于触发工具 | 04 Function Calling |

## G

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Graph** | 图 | LangGraph 的核心抽象：节点是操作、边是流转 | 05 LangGraph 入门 |
| **Grounding** | 落地 | 让 LLM 的回答基于真实数据，减少幻觉，RAG 是主要手段 | 06 RAG 概念 |

## H

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Hallucination** | 幻觉 | LLM 编造的看似合理但事实错误的内容 | 06 RAG 概念 |
| **Handoff** | 交接 | LangGraph 中 Agent 间显式控制权交接的语义，1.x 通过 `Command({ goto: targetAgent, update })` 实现；区别于 Send（参数分发） | 05 Multi-Agent |
| **HITL** | 人机协同 | Human-in-the-Loop，关键操作引入人工审批 | 05 Human-in-the-Loop |
| **HNSW** | 分层导航小世界图 | Hierarchical Navigable Small World，主流向量索引算法 | 06 向量存储 |
| **HyDE** | 假设性文档嵌入 | Hypothetical Document Embeddings，先让 LLM 生成假设答案再用它做检索 | 06 高级 RAG |
| **Hono** | - | 轻量 web 框架，本书 API 层默认使用 | 08 生产部署 |

## I

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Interrupt** | 中断 | LangGraph 暂停图执行的机制，1.x 推荐 typed interrupt | 05 Human-in-the-Loop |
| **Invoke** | 调用 | Runnable 的单次同步执行接口 | 01 Runnable 接口 |

## J-K

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **JSON Mode** | JSON 模式 | 强制模型输出有效 JSON 的 provider 能力 | 01 Output Parsers |

## L

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **LangChain** | - | 构建 LLM 应用的开源框架 | 00 前言 |
| **LangGraph** | - | LangChain 生态的 Agent 编排框架，基于有向图 | 05 LangGraph 入门 |
| **LangSmith** | - | LangChain 官方的可观测性、评估、调试平台 | 07 LangSmith Tracing |
| **LCEL** | LangChain 表达式语言 | LangChain Expression Language，`.pipe()` 串联组件的声明式语法 | 02 Chain 组合 |
| **LLM** | 大型语言模型 | Large Language Model | 00 前言 |
| **LLM-as-judge** | LLM 评判者 | 用一个 LLM 评估另一个 LLM 的输出 | 07 评估 |

## M

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **MCP** | 模型上下文协议 | Model Context Protocol，Anthropic 推出的工具/数据源接入标准 | 04 工具与函数调用 |
| **Memory** | 记忆 | Agent 跨轮次保留上下文的能力，1.x 推荐用 Checkpointer 实现 | 03 记忆系统 |
| **Message** | 消息 | Chat Model 的基本输入输出单元 | 01 模型 IO |
| **Metadata** | 元数据 | 附加在 Document、Trace 等对象上的描述信息 | 06 文档加载 |
| **Multi-Agent** | 多智能体 | 多个专业 Agent 协作完成复杂任务 | 05 Multi-Agent |
| **Multimodal** | 多模态 | 处理文本之外（图像、音频等）数据的模型能力 | 01 模型 IO |

## N-O

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Node** | 节点 | LangGraph 中的基本执行单元（一个函数） | 05 LangGraph 入门 |
| **Output Parser** | 输出解析器 | 把模型文本输出转成结构化数据；1.x 主推 `withStructuredOutput` | 01 Output Parsers |

## P

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **PII** | 个人隐私信息 | Personally Identifiable Information | 08 安全 |
| **Plan-and-Execute** | 先规划再执行 | Agent 模式：先列计划再逐步执行 | 05 Plan-and-Execute |
| **Prompt** | 提示词 | 发给模型的输入文本 | 01 Prompt |
| **Prompt Injection** | 提示词注入 | 通过输入嵌入恶意指令操纵 LLM 的攻击 | 08 安全 |
| **Prompt Template** | 提示词模板 | 带变量占位符的 prompt | 01 Prompt |

## R

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **RAG** | 检索增强生成 | Retrieval-Augmented Generation：先检索、再让 LLM 基于检索结果生成 | 06 RAG 概念 |
| **ReAct** | 推理+行动 | Reasoning + Acting，模型交替"思考-工具调用-观察"的循环 | 05 ReAct 模式 |
| **Reflexion** | 反思 | Agent 自我批判、修正后再次尝试的模式 | 05 Self-Reflection |
| **Reranker** | 重排器 | 对初次检索结果用更强的模型重新打分排序 | 06 高级 RAG |
| **Retriever** | 检索器 | 根据查询返回相关 `Document` 的组件 | 06 Retriever |
| **Runnable** | 可运行对象 | LangChain 所有组件的统一基类，提供 `invoke` / `stream` / `batch` | 01 Runnable 接口 |

## S

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Semantic Search** | 语义搜索 | 基于向量相似度而不是关键词匹配的搜索 | 06 向量存储 |
| **Send** | 分发 | LangGraph 的 Send API，在 `Command` 的 `goto` 里传 `Send` 实例，用于向并发分支分发独立参数；区别于普通节点跳转 | 05 Multi-Agent |
| **SSE** | 服务器推送事件 | Server-Sent Events，HTTP 单向推流协议，本书流式输出默认走 SSE | 08 流式 API |
| **State** | 状态 | LangGraph 中图执行过程维护的数据结构 | 05 State、Channels |
| **StateGraph** | 状态图 | LangGraph 核心类，按 `Annotation` 定义状态后用节点 + 边描述流转 | 05 LangGraph 入门 |
| **Streaming** | 流式输出 | 模型逐 token 返回，而非等全部生成完 | 05 流式输出深入 |
| **Structured Output** | 结构化输出 | 让模型按 schema 输出可被程序消费的 JSON 等结构 | 01 Output Parsers |

## T

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Temperature** | 温度 | 模型采样随机性参数，0=确定性输出 | 01 模型 IO |
| **Text Splitter** | 文本切分器 | 把长文档切成适合 embedding 的短块 | 06 文本切分 |
| **Token** | - | 模型处理文本的最小单元，1 个英文单词 ≈ 1 token，1 个汉字 ≈ 1.5-2 token | 01 模型 IO |
| **Tool** | 工具 | Agent 可调用的外部能力，包含名字、描述、参数 schema | 04 Tool 接口 |
| **Tool Calling** | 工具调用 | 模型生成结构化参数触发工具，同 Function Calling | 04 Function Calling |
| **Trace** | 追踪 | 一次完整请求的全链路执行记录 | 07 LangSmith Tracing |

## U-V

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Vector Store** | 向量存储 | 存储和检索 embedding 向量的数据库（PGVector / Pinecone / Qdrant 等） | 06 向量存储 |

## W-Z

| 术语 | 中文 | 解释 | 首次出现 |
|------|------|------|----------|
| **Zero-Shot** | 零样本 | 不给示例直接让模型干活 | 01 Prompt |
| **Zod** | - | TypeScript-first 的 schema 验证库，本书用它定义所有工具参数 | 04 Tool 接口 |

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
