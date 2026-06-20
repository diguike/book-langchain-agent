---
title: LangGraph Platform 部署
feishu_url: ""
last_synced: ""
---

> 模块 08 - 生产部署 | 前置知识：[API 服务化](./01-api-server.md)、[流式接口部署](./02-streaming-api.md)、[State 与 Checkpointer](../05-agent-architecture/04-langgraph-state.md)

## 自己搭一套服务很累

[API 服务化](./01-api-server.md) 和 [流式接口部署](./02-streaming-api.md) 教你用 Hono 把 Agent 包成 HTTP 服务：自己写路由、自己接 SSE、自己挂 checkpointer、自己管 thread 生命周期。能用，但你会发现一堆活在重复造：会话历史的增删改查、中断恢复的接口、长任务的后台执行、定时任务、鉴权……每个生产 Agent 都要这一套。

LangGraph 把这套东西标准化成了 **LangGraph Server**——一个把你的 graph 直接变成带 threads / runs / assistants / store 全套 REST API 的运行时。你只写 graph，部署、持久化、流式、中断恢复全归它管。本地一条命令就能跑起来，上生产换个部署形态、前端代码不用动。

这一节把一个 `createAgent` 部署成 LangGraph Server，并讲清楚本地开发、自托管、托管 Platform 三种形态的区别。

## 一个配置文件 + 一条命令

LangGraph Server 靠根目录的 `langgraph.json` 描述「有哪些图、用什么环境」。Node 项目的最小配置：

```json
{
  "$schema": "https://langgra.ph/schema.json",
  "node_version": "20",
  "graphs": {
    "agent": "./src/agent.ts:graph"
  },
  "env": ".env"
}
```

三个要点，每个都是 2025 旧记忆容易写错的地方：

1. **Node 项目用 `node_version`（`"20"` 或 `"22"`），不是 `python_version`**。
2. **`graphs` 的 value 必须是 `文件:导出名` 格式**（带冒号），只给文件路径会报错。
3. **Node 项目不需要 `dependencies` 字段**（那是 Python 项目必填的），CLI 直接读你的 `package.json`。

被 `graphs` 指向的文件，导出一个已编译的图就行。`createAgent` 的返回值本身就是已编译的图，直接导出：

```typescript
// src/agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

export const graph = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});
```

也可以导出 `new StateGraph(...).compile()`。注意 `graphs` 里的 **key（这里 `"agent"`）就是前端要用的 `assistantId`**，下一节 [生成式 UI](../10-frontend-ui/01-streaming-ui-usestream.md) 的 `useStream({ assistantId: "agent" })` 用的就是它。

跑起来——本地开发用 `dev`，热重载、不需要 Docker：

```bash
npx @langchain/langgraph-cli dev
# Server 跑在 http://localhost:2024，自带 LangGraph Studio 可视化调试
```

就这样。你没写一行 HTTP 路由，但已经有了完整的 threads / runs / assistants / store API，外加一个可视化调试台 Studio。`createAgent` 内部的 checkpointer、中断恢复、流式，全部由 Server 接管。

## 三种部署形态

LangGraph Server 有三种跑法，**对前端代码零差异**——永远是 `useStream({ apiUrl, assistantId, apiKey? })`，换部署只换这三个参数。

| 形态 | 命令 | 端口 | 依赖 | 用途 |
|------|------|------|------|------|
| 本地开发 | `langgraphjs dev` | 2024 | 无（无需 Docker） | 教程、本地调试，配 Studio |
| 自托管容器 | `langgraphjs up` / `build` | 8123 | Docker + `LANGSMITH_API_KEY` | 本地容器验证、自己上 K8s |
| 托管 Platform | 连 GitHub 仓库 | 平台分配 | LangSmith 账号 | 托管生产，自动构建部署 |

注意 `dev` 和 `up` 的**默认端口不一样**（2024 vs 8123），前端 `apiUrl` 要对得上。

自托管出镜像：

```bash
# 构建可部署的 Docker 镜像
npx @langchain/langgraph-cli build -t my-agent:latest

# 或本地用 Docker 跑起来验证（需要 LANGSMITH_API_KEY）
npx @langchain/langgraph-cli up --port 8123
```

`build` 出来的镜像可以推到任意容器平台（ECS / K8s / Cloud Run）自己跑。托管 Platform 则是把仓库连上去，平台读你的 `langgraph.json` 自动构建部署，给你一个带鉴权的 `apiUrl` + API key——适合不想管基建的团队。

三者的取舍很直接：**本地开发一律 `dev`**（最省事）；**要完全自己掌控基建就 `build` 出镜像自托管**；**不想碰运维就上托管 Platform**。

## Server 暴露了什么 API

LangGraph Server 的 REST 面分成四组，`@langchain/langgraph-sdk` 的 `Client` 一一对应，不用前端的话也能直接 curl：

| 子客户端 | REST 路由 | 干什么 |
|----------|-----------|--------|
| `client.assistants.*` | `/assistants` | 列出 / 创建 assistant |
| `client.threads.*` | `/threads` | 会话的创建、取状态、改状态、看历史 |
| `client.runs.*` | `/threads/{id}/runs` | 在某个 thread 上发起 / 流式 / 取消运行 |
| `client.store.*` | `/store/items` | 长期记忆的读写与语义检索 |
| `client.crons.*` | `/runs/crons` | 定时触发的运行 |

非 React 场景（后端对后端、CLI）直接用 `Client`：

```typescript
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

// 建会话，发起一次流式运行
const thread = await client.threads.create();
const stream = client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "你好" }] },
  streamMode: "messages-tuple",
});
for await (const chunk of stream) {
  console.log(chunk.event, chunk.data);
}
```

这里有个和本地直跑 graph 的关键区别：**Server 的流式用 `streamMode: "messages-tuple"`**，而 [流式接口部署](./02-streaming-api.md) 里本地直接 `graph.stream()` 用的是 `"messages"`。`messages-tuple` 是 Platform HTTP 层的流模式，本地 graph 没有这个值——别把两者搞混。

还有一个概念要分清：**assistant 不等于 graph**。一个 graph 可以派生出多个 assistant（带不同的默认配置、不同的 context），但最简单的场景下，`langgraph.json` 里的 graph key 会自动作为一个同名 assistant 直接可用，前端拿这个名当 `assistantId` 就行。

## 什么时候该上 Server

不是所有 Agent 都需要 LangGraph Server。一个判断清单：

- **只是个无状态的一问一答接口** → 用 [Hono 自己包](./01-api-server.md) 更轻，不必引入 Server。
- **要多轮会话、要中断恢复（HITL）、要长任务后台跑、要给前端做聊天 UI** → 上 Server，这些它全帮你做了，自己写要写很久。
- **团队不想维护"会话存储 + 流式 + 中断"这套基建** → 上 Server，把精力留给 graph 本身。

实战路线：**本地 `langgraphjs dev` 起步**，graph 跑通、Studio 里调好；要上线时再决定自托管出镜像还是托管 Platform。前端始终对着 `useStream`，底层换形态它不感知。

## 小结

LangGraph Server 把你的 graph 直接变成带 threads / runs / assistants / store 全套 REST API 的运行时，省掉自己写 HTTP 路由、会话存储、中断恢复、流式这一堆重复活。配置就一个 `langgraph.json`（Node 用 `node_version`、`graphs` 写 `文件:导出`、不用写 `dependencies`），本地一条 `langgraphjs dev`（端口 2024，无需 Docker）就跑起来还带 Studio。三种形态——本地 dev / 自托管镜像 / 托管 Platform——对前端零差异，只换 `apiUrl` / `assistantId` / `apiKey`。Server 流式用 `messages-tuple`，区别于本地 graph 的 `messages`。

graph 跑成了 Server，前端就能接上了。下一节 [生成式 UI 与 useStream](../10-frontend-ui/01-streaming-ui-usestream.md) 用一个 React hook 把这个 Server 的 token 流、工具调用、HITL 中断直接渲染成聊天界面。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
