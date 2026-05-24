---
title: MCP Server 集成
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/HT90wgKzKiIVWmkE9tjcSWWAnPh"
last_synced: "2026-05-25T02:41:51+08:00"
---

> 模块 04 - 工具与函数调用 | 前置：[Function Calling 跨模型统一](./03-function-calling.md) | 后续：[外部系统集成模式](./05-external-integration.md)

## MCP 解决了什么问题

我自己写了几年 Agent 工具后，越来越觉得一件事不对劲：每个项目都在重复造轮子。文件系统、Git、GitHub、Slack、Postgres——这些通用能力，我已经第 N 次手写包装 Tool 了。换一个项目就重抄一遍。

MCP (Model Context Protocol) 是 Anthropic 在 2024 年提出、2025 年成为事实标准的开放协议，专门解决这个问题。核心思路：**把工具的提供者（MCP Server）和消费者（Agent）解耦**，用 JSON-RPC 2.0 作为通信协议。

> 官方协议规范：[https://modelcontextprotocol.io/](https://modelcontextprotocol.io/)

```
┌──────────────┐     MCP 协议     ┌──────────────┐
│  Agent 应用  │ ◄──────────────► │  MCP Server  │
│  (Client)    │   JSON-RPC 2.0  │  (工具提供者) │
└──────────────┘                  └──────────────┘
```

实际带来的红利：

- 文件系统、Git、GitHub 等通用工具直接用社区 Server，不用自己写
- 团队里 Python 同事写的工具，Node.js Agent 直接消费
- 同一个工具集，本地开发、Docker、远程服务都能用

LangChain.js 1.x 通过 `@langchain/mcp-adapters` 提供了官方的 MCP 集成。当前 MCP 协议是 1.0+，主流 SDK 实现都跟得上。

## MCP 的三个核心能力

| 能力 | 说明 | Agent 视角 |
|------|------|-----------|
| **Tools** | 可执行函数（文件读写、SQL 查询、API 调用） | 模型可以选择调用，跟普通 Tool 等价 |
| **Resources** | 只读数据（文件内容、表结构、配置） | 模型可以引用的上下文 |
| **Prompts** | 预定义提示模板 | Agent 可以挑选适合的模板 |

本章聚焦 Tools，这是与 LangChain.js Agent 集成最核心的部分。Resources 和 Prompts 在 [07-可观测性与评估](../07-observability) 模块里展开。

## Transport：两种传输方式

MCP Server 跟 Client 之间走两种通道：

**stdio Transport**——本地子进程，通过 stdin/stdout 通信。适合本地工具（文件、Git、本地数据库）：

```
┌─────────┐  stdin/stdout  ┌────────────┐
│ Client  │ ◄────────────► │ MCP Server │
│         │                │  (子进程)  │
└─────────┘                └────────────┘
```

**HTTP/SSE Transport**——远程 HTTP，用 Server-Sent Events 实现服务端推送。适合云端服务、共享工具：

```
┌─────────┐    HTTP / SSE      ┌────────────┐
│ Client  │ ◄────────────────► │ MCP Server │
│         │                    │  (远程服务) │
└─────────┘                    └────────────┘
```

协议的握手流程很简单：`initialize` → `tools/list` → `tools/call` → 循环。LangChain.js 把这些细节都封进了 `MultiServerMCPClient` 里，你不用直接写 JSON-RPC。

## 安装与基础用法

```bash
npm install @langchain/mcp-adapters @langchain/core
# MCP 协议 SDK 是 peer dependency，需要一并装
npm install @modelcontextprotocol/sdk
```

最小可用示例：连接官方的文件系统 MCP Server：

```typescript
// fs-mcp-basic.ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  mcpServers: {
    filesystem: {
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp/workspace",  // 允许访问的根目录
      ],
    },
  },
});

// 拉取所有 Server 上注册的工具
const tools = await client.getTools();

console.log("可用工具:");
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

// 工具本身就是标准的 StructuredTool 实例，可以直接 invoke
const listDir = tools.find((t) => t.name === "list_directory");
if (listDir) {
  const result = await listDir.invoke({ path: "/tmp/workspace" });
  console.log(result);
}

// 用完关闭
await client.close();
```

跑这段代码会自动 `npx -y` 拉起官方的 `@modelcontextprotocol/server-filesystem` Server，连上后列出它注册的工具——`read_file`、`write_file`、`list_directory`、`create_directory`、`search_files` 等。

## 接入 Agent：tools 数组直接传给 createAgent

MCP 拉取的工具跟自定义 Tool 完全等价，同样是 `StructuredTool` 的实例，可以直接拼到 `createAgent` 的 tools 数组里：

```typescript
// fs-mcp-agent.ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";

const client = new MultiServerMCPClient({
  mcpServers: {
    filesystem: {
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp/workspace",
      ],
    },
  },
});

const tools = await client.getTools();

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools,
  systemPrompt:
    "你是一个文件系统助手。所有操作都在 /tmp/workspace 内进行。完成后简短回报结果。",
});

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "请在 /tmp/workspace 下创建一个 hello.txt，内容是 'Hello, MCP!'，然后读取它确认内容",
    },
  ],
});

console.log(result.messages.at(-1)?.content);

await client.close();
```

注意配置格式：1.x 的 `MultiServerMCPClient` 用 `{ mcpServers: { ... } }` 包装，跟 MCP 客户端通用配置（`.mcp.json`）一致。

## 同时连多个 Server

`MultiServerMCPClient` 之所以叫 "Multi"，是因为它能并行连多个 Server，工具集自动汇总：

```typescript
const client = new MultiServerMCPClient({
  mcpServers: {
    // 本地文件系统
    filesystem: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"],
    },

    // GitHub 操作（社区 Server，需要 token）
    github: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN!,
      },
    },

    // 自建业务 Server（HTTP）
    business: {
      transport: "http",
      url: "https://mcp.mycompany.com/mcp",
      headers: {
        Authorization: `Bearer ${process.env.MCP_TOKEN}`,
      },
    },
  },
});

const tools = await client.getTools();
console.log(`合并后总共 ${tools.length} 个工具`);

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools,
  systemPrompt: "你是一个全能助手，能操作文件系统、GitHub 和业务系统。",
});
```

工具命名上 `@langchain/mcp-adapters` 会自动加 Server 前缀避免冲突——比如 `filesystem__read_file`、`github__create_issue`。

## HTTP Transport：连接远程 MCP Server

1.x 推荐用 streamable HTTP transport，比老的纯 SSE 更稳定：

```typescript
const client = new MultiServerMCPClient({
  mcpServers: {
    "remote-tools": {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: `Bearer ${process.env.MCP_API_KEY}`,
      },
      // 可选：连接超时（毫秒）
      timeout: 30000,
    },
  },
});

const tools = await client.getTools();
// 之后用法完全一样，tools 直接传给 createAgent
```

如果对端 Server 只支持老的 SSE Transport：

```typescript
{
  transport: "sse",
  url: "https://legacy.example.com/sse",
  headers: { ... },
}
```

## 自建 MCP Server：Node.js 实现

如果团队有内部业务 API，想做成 MCP Server 让 Agent 消费，用官方 `@modelcontextprotocol/sdk` 几十行就能搭：

```typescript
// my-mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-business-server",
  version: "1.0.0",
});

// 注册一个工具
server.tool(
  "get_order_status",
  "查询订单状态",
  {
    orderId: z.string().describe("订单 ID"),
  },
  async ({ orderId }) => {
    // 真实场景查数据库
    const status = await queryOrderStatus(orderId);
    return {
      content: [
        { type: "text", text: JSON.stringify(status) },
      ],
    };
  }
);

server.tool(
  "send_notification",
  "向用户发送通知",
  {
    userId: z.string(),
    message: z.string(),
    channel: z.enum(["email", "sms", "push"]),
  },
  async ({ userId, message, channel }) => {
    await sendNotification(userId, message, channel);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: true, channel }) },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// 假函数，演示用
async function queryOrderStatus(id: string) {
  return { orderId: id, status: "shipped", carrier: "顺丰" };
}
async function sendNotification(uid: string, msg: string, ch: string) {}
```

写好后从 LangChain.js 端连接：

```typescript
const client = new MultiServerMCPClient({
  mcpServers: {
    "my-business": {
      transport: "stdio",
      command: "npx",
      args: ["tsx", "./my-mcp-server.ts"],
    },
  },
});
```

## MCP Tools 跟自定义 Tools 混用

最常见的混合模式：核心业务工具自己写（更可控），通用能力用 MCP（复用生态）。两者无缝混用：

```typescript
// hybrid-tools.ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 1. MCP 提供的通用工具：文件系统
const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    filesystem: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
});
const mcpTools = await mcpClient.getTools();

// 2. 自己定义的业务工具
const getCurrentTime = tool(
  async () => new Date().toISOString(),
  {
    name: "get_current_time",
    description: "获取当前 ISO 8601 时间戳",
    schema: z.object({}),
  }
);

const queryOrder = tool(
  async ({ orderId }) => {
    // 业务数据库查询
    return JSON.stringify({ orderId, status: "shipped" });
  },
  {
    name: "query_order",
    description: "查询订单状态",
    schema: z.object({
      orderId: z.string().describe("订单 ID"),
    }),
  }
);

// 3. 合并所有工具
const allTools = [...mcpTools, getCurrentTime, queryOrder];

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: allTools,
  systemPrompt: "你是一个业务助手，可以查订单、操作文件、读取时间。",
});

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "查一下订单 ORD123 的状态，然后把结果连同当前时间写入 /tmp/order-log.txt",
    },
  ],
});

console.log(result.messages.at(-1)?.content);

await mcpClient.close();
```

## 生产部署的几个要点

### 连接错误与重连

MCP Server 是独立进程或远程服务，连接失败是必须考虑的常态。我会在初始化阶段做有限重试：

```typescript
async function createResilientClient() {
  const config = {
    mcpServers: {
      filesystem: {
        transport: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    },
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const client = new MultiServerMCPClient(config);
      const tools = await client.getTools();
      return { client, tools };
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const backoff = 1000 * 2 ** attempt;
      console.error(`MCP 连接失败 (${attempt + 1}/${maxRetries})，${backoff}ms 后重试`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error("unreachable");
}
```

### 生命周期管理

stdio Transport 启动的 MCP Server 是子进程，应用退出时要清理：

```typescript
const { client } = await createResilientClient();

process.on("SIGINT", async () => {
  console.log("收到中断信号，清理 MCP 连接...");
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});
```

Web 服务里我会把 `MultiServerMCPClient` 做成单例，应用启动时初始化，shutdown 时统一关闭。

### 工具列表的稳定性

MCP Server 启动后工具列表可能动态变化（比如热加载新工具）。但 Agent 一旦初始化，`createAgent` 的 tools 是固定的。如果你需要动态工具，要么定期重建 Agent，要么用 [Middleware 系统](../05-agent-architecture/07-middleware.md) 在请求时动态调整。

大多数业务场景下，启动时拉一次工具列表就够了。

## MCP vs 直接定义 Tool 的选择

| 维度 | 直接定义 Tool | MCP Server |
|------|:---:|:---:|
| 开发速度 | 快（同进程） | 中（要起独立 Server） |
| 语言灵活性 | 仅 TypeScript | 任何语言 |
| 复用性 | 低（项目内部） | 高（跨项目跨框架） |
| 生态工具数量 | 自己开发 | 社区 Server 丰富 |
| 部署复杂度 | 低 | 中（管理额外进程） |
| 性能 | 高（无 IPC） | 略低（进程间通信） |
| 安全隔离 | 无（同进程） | 有（进程隔离） |

我的实际选择规则：

- **业务核心逻辑**：自己写 Tool，更快也更可控
- **文件、Git、Postgres、Slack 这类通用能力**：用社区 MCP Server
- **跨语言团队**：MCP（Python 同事写 Server，Node.js Agent 消费）
- **需要进程隔离保护**：MCP（出问题 Server 进程崩了不影响 Agent）

## 小结

MCP 把工具生态从"应用内自定义"扩展到"全社区共享"。`@langchain/mcp-adapters` 让 LangChain.js Agent 无缝接入这个生态：

- `MultiServerMCPClient` 同时连多个 Server，工具自动汇总
- 三种 transport：`stdio`（本地）、`http`（推荐的远程）、`sse`（老协议）
- MCP 工具跟自定义 Tool 等价，直接传给 `createAgent({ model, tools })`
- 生产部署考虑：重连、生命周期管理、单例

下一节 [外部系统集成模式](./05-external-integration.md) 从更宏观的角度讨论 Agent 与外部系统集成的安全、权限、限流模式。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
