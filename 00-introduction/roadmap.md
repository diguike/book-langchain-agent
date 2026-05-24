---
title: 课程路线图
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/Xbn5wMlqZix4WTkhwYoc6LcdnbW"
last_synced: "2026-05-25T02:40:32+08:00"
---

## 课程目标与受众定位

本课程的核心目标是：**让你具备使用 LangChain.js 独立设计、开发和部署生产级 AI Agent 应用的能力。**

课程结束时，你将能够：

- 熟练运用 LangChain.js 1.x 全套 API 构建 LLM 应用
- 设计多步骤、可回溯、具备工具调用能力的 Agent 系统
- 构建完整的 RAG（Retrieval-Augmented Generation）管道
- 使用 LangGraph.js 编排复杂的多 Agent 工作流
- 通过 LangSmith 实现可观测性、评估与调试
- 将 AI 应用从原型推进到生产部署

### 适合谁学

| 受众类型 | 前提条件 | 学完可达到的水平 |
|---------|---------|----------------|
| 有 1-2 年经验的前端/Node.js 开发者 | 熟悉 TypeScript、async/await | 能独立开发 AI Agent 产品 |
| 后端开发者想拓展 AI 方向 | 有任意语言后端经验 | 掌握 LLM 应用全链路架构 |
| Python LangChain 用户想迁移到 JS 生态 | 了解 LangChain 概念 | 快速上手 JS/TS 等效实现 |
| 技术负责人 / 架构师 | 需要评估 AI 技术选型 | 理解 Agent 架构的工程权衡 |

### 不适合谁

- 完全没有编程经验的初学者（请先学习 JavaScript/TypeScript 基础）
- 期望学习模型训练或微调的研究者（本课程聚焦应用层）

---

## 整体学习路径

课程共 **8 大模块 + 4 个综合项目**，按照从基础到高级的递进关系编排：

```
模块 1: 核心抽象          ──  Runnable / LCEL / Model I/O / Prompt / Parser
模块 2: Chain 组合         ──  RunnableSequence / Parallel / Branch / Streaming / Fallback
模块 3: 记忆系统           ──  Checkpointer / Store / 多用户隔离
模块 4: 工具与函数调用      ──  Tool / Function Calling / MCP
模块 5: Agent 架构         ──  createAgent / Middleware / LangGraph / Multi-Agent / HITL
模块 6: RAG               ──  Loader / Splitter / Retriever / Advanced RAG / RAG Agent
模块 7: 可观测性与评估      ──  Callback / LangSmith / Evaluation / Prompt Engineering
模块 8: 生产部署           ──  API / Streaming / Cache / Security / Deployment
综合项目                   ──  智能客服 / 代码助手 / 数据分析 / 多 Agent 平台
```

模块之间的依赖关系如下图所示：

```
┌────────────────────────────────────────────────────┐
│                  模块 1: 核心抽象                     │
│     (Model, Prompt Template, Output Parser)         │
└──────────────────────┬─────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   ┌──────────────┐         ┌──────────────┐
   │ 模块 2: Chain │         │ 模块 3: 记忆  │
   └──────┬───────┘         └──────┬───────┘
          │                        │
          └───────────┬────────────┘
                      ▼
            ┌──────────────────┐
            │ 模块 4: 工具调用   │
            └────────┬─────────┘
                     ▼
            ┌──────────────────┐
            │ 模块 5: Agent     │
            └────────┬─────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌──────────────┐    ┌───────────────┐
   │ 模块 6: RAG   │    │ 模块 7: 可观测 │
   └──────┬───────┘    └───────┬───────┘
          │                    │
          └────────┬───────────┘
                   ▼
          ┌──────────────────┐
          │ 模块 8: 生产部署   │
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │    综合项目        │
          └──────────────────┘
```

**关键设计原则：** 模块 2 和模块 3 可以并行学习；模块 6 和模块 7 也可以并行学习。但模块 4（工具调用）是模块 5（Agent）的硬性前置依赖——Agent 的核心能力就是调用工具。

---

## 每个模块的核心产出物

每个模块都遵循 **"概念 → API → 实战 → 产出"** 的四步教学法。以下是各模块结束时你应该完成的产出物：

| 模块 | 核心产出物 | 复杂度 |
|------|-----------|--------|
| 模块 1: 核心抽象 | 一个支持多 Provider 切换的 ChatBot CLI 工具 | ★☆☆☆☆ |
| 模块 2: Chain 组合 | 一个多步骤内容生成管道（翻译 → 摘要 → 格式化） | ★★☆☆☆ |
| 模块 3: 记忆系统 | 用 checkpointer 实现可持久化、可多用户隔离的对话系统 | ★★☆☆☆ |
| 模块 4: 工具调用 | 一个能查天气、搜网页、算数学的工具增强 Agent | ★★★☆☆ |
| 模块 5: Agent 架构 | 用 createAgent 和 LangGraph 构建带 Middleware 和 HITL 的复杂 Agent | ★★★★☆ |
| 模块 6: RAG | 自适应 RAG Agent，含向量检索、Rerank 和置信度回退 | ★★★★☆ |
| 模块 7: 可观测性 | 集成 LangSmith Tracing + Dataset 评估 + 自定义指标 | ★★★☆☆ |
| 模块 8: 生产部署 | 将 Agent 部署为带流式 / 缓存 / 安全防御的生产 HTTP 服务 | ★★★★☆ |
| 综合项目 | 智能客服 / 代码助手 / 数据分析 / 多 Agent 平台 任选一个完整实现 | ★★★★★ |

---

## 建议学习节奏

以下时间预估基于每天投入 **1-2 小时** 的学习节奏：

| 模块 | 预估时间 | 建议节奏 |
|------|---------|---------|
| 模块 0: 导论与环境搭建 | 0.5 天 | 第 1 天上午 |
| 模块 1: 核心抽象 | 3 天 | 第 1 周前半 |
| 模块 2: Chain 组合 | 3 天 | 第 1 周后半 |
| 模块 3: 记忆系统 | 3 天 | 第 2 周前半 |
| 模块 4: 工具与函数调用 | 4 天 | 第 2 周后半 ~ 第 3 周初 |
| 模块 5: Agent 架构 | 5 天 | 第 3 周 |
| 模块 6: RAG | 5 天 | 第 4 周 |
| 模块 7: 可观测性与评估 | 3 天 | 第 5 周前半 |
| 模块 8: 生产部署 | 3 天 | 第 5 周后半 |
| 综合项目 | 5-7 天 | 第 6 周 |
| **合计** | **约 5-6 周** | |

> **提示：** 如果你已经有 LangChain Python 经验，可以将模块 1-3 的时间压缩一半，重点关注 JS/TS 生态的差异点。

---

## 技术栈全景

本课程的完整技术栈如下：

### 核心运行时与语言

| 技术 | 版本要求 | 用途 |
|------|---------|------|
| **Node.js** | 20+ (LTS) | 运行时环境，原生支持 ES Module |
| **TypeScript** | 5.x | 类型安全，Zod schema 集成 |
| **npm** | 10+ | 包管理器（默认），pnpm / bun 也可 |

### LangChain.js 生态（1.x）

| 包名 | 用途 |
|------|------|
| `langchain` | Agent 主入口（`createAgent`、Middleware） |
| `@langchain/core` | 核心抽象（Runnable、Message、Prompt、Parser） |
| `@langchain/langgraph` | 状态机底层（StateGraph、Checkpointer） |
| `@langchain/openai` | OpenAI GPT-5 / GPT-4o 集成 |
| `@langchain/anthropic` | Anthropic Claude 4.x 集成 |
| `@langchain/community` | 社区集成（Vector Store、Loader、Tool 等） |
| `@langchain/classic` | 1.0 之前的 legacy API（兼容性容身处，不主推） |

### 模型选型（2026 年当下）

| 场景 | 推荐模型 |
|------|----------|
| 旗舰（复杂规划 / 长上下文） | Claude Opus 4.7、GPT-5 系列旗舰款 |
| 平衡（大多数 Agent 工作负载） | Claude Sonnet 4.6、GPT-5 系列标准款、GPT-4.1 |
| 速度（简单分类 / 路由 / 低延迟） | Claude Haiku 4.5、GPT-5 系列 mini、GPT-4o-mini |
| 国产（境内合规场景） | DeepSeek V4、Moonshot Kimi、阿里通义 Qwen3 |

### 可观测性与评估

| 技术 | 用途 |
|------|------|
| **LangSmith** | Trace 追踪、Prompt 管理、评估实验 |

### 辅助工具

| 技术 | 用途 |
|------|------|
| **Zod** | Runtime schema 校验，LangChain 结构化输出的基础 |
| **dotenv** | 环境变量管理 |
| **VS Code** | 推荐 IDE |

---

## 学完之后能做什么

完成全部课程后，你将具备以下能力矩阵：

### 技术能力

- **构建对话系统：** 基于 LangChain.js 开发多轮对话 Bot，支持上下文记忆与会话管理
- **开发 AI Agent：** 使用 LangGraph.js 编排复杂的多步骤推理、工具调用和决策循环
- **搭建 RAG 管道：** 从文档摄入 → 向量化 → 检索 → 生成的全流程实现
- **集成多 LLM Provider：** 灵活切换 OpenAI、Anthropic 等模型供应商
- **监控与评估：** 使用 LangSmith 追踪每次调用、定义评估指标、持续优化
- **生产部署：** 将 Agent 部署为可伸缩的 HTTP 服务，处理流式输出与错误恢复

### 可以构建的产品类型

- 企业知识库问答系统
- 智能客服 Agent
- 代码生成 / Review 助手
- 多步骤数据分析 Agent
- 文档摘要与翻译管道
- 个人 AI 助理（日程管理、信息检索、任务编排）

### 职业发展

掌握 LangChain.js Agent 开发，意味着你可以胜任以下岗位：

- AI 应用工程师
- LLM 应用架构师
- Full-stack AI 开发者
- AI 产品技术负责人

---

准备好后，先读 [前置知识清单](./prerequisites.md) 确认基础，再跟着 [环境搭建指南](./setup.md) 配好开发环境，就可以正式开始了。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
