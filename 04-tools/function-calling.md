---
title: Function Calling 跨模型统一
feishu_url: ""
last_synced: ""
---

> 模块 04 - 工具与函数调用 | 前置：[Tool 接口与定义](./tool-interface.md)、[自定义 Tool 开发](./custom-tool.md) | 后续：[MCP Server 集成](./mcp-server.md)

## 同一个 Tool，三家协议

我写完一个 Tool 之后，最常被问的问题是：能不能在 Claude 和 GPT 之间切？答案是能。但只有在用 LangChain.js 1.x 的抽象层时才能"无痛切"——直接对接厂商 SDK 的话，三家协议各有怪癖。

底层是这样的：

- **OpenAI** 的 Function Calling 用 `tools` 参数，每个 tool 包一层 `{ type: "function", function: {...} }`，响应在 `tool_calls` 数组里，参数是 JSON 字符串
- **Anthropic** 的 Tool Use 用 `input_schema` 而非 `parameters`，工具调用混在 `content` block 里（`type: "tool_use"`），参数是对象
- **Google Gemini** 用 `functionDeclarations` 包装，类型名大写（`OBJECT`、`STRING`）

LangChain.js 1.x 把这些差异都封在 `createAgent` 内部。你只写一次 Tool，传同一个数组进去，背后哪家模型都能跑。

## 1.x 的统一模式：直接传 tools 给 createAgent

```typescript
// cross-model-agent.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";

// 定义一次，三家通用
const getWeather = tool(
  async ({ city }) => {
    return JSON.stringify({ city, temperature: 22, condition: "晴" });
  },
  {
    name: "get_weather",
    description: "获取指定城市的实时天气",
    schema: z.object({
      city: z.string().describe("城市名"),
    }),
  }
);

const calculate = tool(
  async ({ expression }) => {
    return String(Function(`"use strict"; return (${expression})`)());
  },
  {
    name: "calculate",
    description: "计算数学表达式",
    schema: z.object({
      expression: z.string().describe("数学表达式，如 '2 + 3 * 4'"),
    }),
  }
);

const tools = [getWeather, calculate];

// 三家模型，同一套 tools，同一个 createAgent
const claudeAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools,
});

const gptAgent = createAgent({
  model: new ChatOpenAI({ model: "gpt-5" }),
  tools,
});

// Gemini 同理（需要 @langchain/google-genai）
// const geminiAgent = createAgent({
//   model: new ChatGoogleGenerativeAI({ model: "gemini-2.5-pro" }),
//   tools,
// });

async function ask(agent: any, q: string) {
  const result = await agent.invoke({
    messages: [{ role: "user", content: q }],
  });
  return result.messages.at(-1)?.content;
}

console.log("Claude:", await ask(claudeAgent, "北京今天天气怎么样？比 20 度高多少？"));
console.log("GPT:", await ask(gptAgent, "北京今天天气怎么样？比 20 度高多少？"));
```

注意三件事：

1. **没有 `.bindTools()`**——1.x 把绑定逻辑收到 `createAgent` 内部，直接把 `tools` 数组交给它就行。手动 `.bindTools()` 再传给 Agent 在 1.x 是反模式。
2. **没有手写循环**——`createAgent` 内部跑了 LangGraph 的 `model ↔ tools` 循环，详见 [createAgent 入门](../05-agent-architecture/create-agent.md)。
3. **同一个 invoke 入口**——`{ messages: [...] }`，每家模型行为一致。

## tool_calls 的统一格式

无论底层是哪家厂商，LangChain.js 把响应里的 tool calls 标准化为同一种结构：

```typescript
interface ToolCall {
  name: string;                    // 工具名
  args: Record<string, unknown>;   // 已解析的参数对象（不是 JSON 字符串）
  id?: string;                     // 调用 ID
  type: "tool_call";
}
```

OpenAI 原生返回的 `arguments` 是 JSON 字符串，Anthropic 是 `input` 对象，Gemini 是 `functionCall.args` 对象——这些差异在 LangChain.js 抽象层都被抹平了。你拿到的永远是已经 `JSON.parse` 好的对象。

如果你想看模型当前一轮选了哪些工具（不跑完整 Agent 循环，只看一步），可以直接 invoke 模型实例：

> **仅用于调试观察单步决策**。生产代码请用 `createAgent({ model, tools })`，不要直接调 `model.invoke`。

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

// 注意：这是为了"看一步"才直接用模型。生产代码用 createAgent 跑完整循环
const model = new ChatAnthropic({ model: "claude-haiku-4-5" });
const response = await model.invoke([new HumanMessage("北京天气？")], {
  tools,  // 1.x 把 tools 通过 invoke 选项传入，而非 .bindTools()
});

if (response.tool_calls && response.tool_calls.length > 0) {
  for (const tc of response.tool_calls) {
    console.log(`工具: ${tc.name}`);
    console.log(`参数: ${JSON.stringify(tc.args)}`);
  }
}
```

## tool_choice：控制模型如何选工具

四种策略，在 invoke 的 `tool_choice` 参数里指定：

```typescript
// 1. auto（默认）：模型自行决定是否调工具
await model.invoke(messages, { tools, tool_choice: "auto" });

// 2. required（OpenAI）/ any（Anthropic）：必须调至少一个工具
await model.invoke(messages, { tools, tool_choice: "required" });

// 3. 指定具体工具：强制调用某个工具，不会调其他
await model.invoke(messages, {
  tools,
  tool_choice: { type: "tool", name: "get_weather" },
});

// 4. none：禁止调工具，纯文本回答
await model.invoke(messages, { tools, tool_choice: "none" });
```

每种策略的适用场景：

| 策略 | 行为 | 何时用 |
|------|------|--------|
| `"auto"` | 模型自行判断 | 大多数对话型 Agent |
| `"required"` | 必须调一个工具 | 工具导向的固定流程 |
| `{ type: "tool", name }` | 必须调指定工具 | 结构化信息提取、强制走特定路径 |
| `"none"` | 禁用工具 | 临时让模型"安静"地回答 |

`createAgent` 内部默认 `auto`，需要其他策略时可以通过 middleware 调整（详见 [Middleware 系统](../05-agent-architecture/middleware.md)）。

## 并行工具调用

现代模型（Claude 4.x、GPT-5、Gemini 2.5）都支持一次响应返回多个 tool_calls。`createAgent` 内部会自动 `Promise.all` 并行执行，不需要你写任何并发逻辑。

举个例子：用户问"北京天气怎么样？同时帮我算 22 * 1.8 + 32"。模型会一次性吐出两个 tool_calls：

```
{
  tool_calls: [
    { name: "get_weather", args: { city: "北京" }, id: "call_1" },
    { name: "calculate", args: { expression: "22 * 1.8 + 32" }, id: "call_2" }
  ]
}
```

`createAgent` 并行跑这两个工具，把两个 `ToolMessage` 一起塞回消息历史，再喂给模型整合最终答案。整个过程你写的代码只有 `createAgent({ model, tools })`。

如果你想禁用并行（某些场景要求工具必须串行，比如有依赖关系）：

```typescript
// OpenAI 通过 modelKwargs 关掉并行
const model = new ChatOpenAI({
  model: "gpt-5",
  modelKwargs: { parallel_tool_calls: false },
});

// Anthropic 通过 disable_parallel_tool_use 关掉
const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  invocationKwargs: { disable_parallel_tool_use: true },
});
```

## 模型能力差异表

虽然 LangChain.js 抽象层很统一，但底层模型在 Function Calling 上还是有差异。我整理了 2026 年中的能力对照（持续变化，写代码前最好上厂商文档复核）：

| 能力 | Claude Opus 4.7 / Sonnet 4.6 | GPT-5 / GPT-5.4 | Gemini 2.5 Pro | 本地 Ollama |
|------|:---:|:---:|:---:|:---:|
| 基础 Function Calling | 是 | 是 | 是 | 部分模型 |
| 并行工具调用 | 是 | 是 | 是 | 否 |
| `tool_choice: auto/required` | 是 | 是 | 是 | 有限 |
| 强制指定工具 | 是 | 是 | 是 | 否 |
| 嵌套对象 schema | 是 | 是 | 是 | 不稳定 |
| 复杂 enum / union | 是 | 是 | 是 | 不稳定 |
| Streaming tool calls | 是 | 是 | 是 | 有限 |
| 长工具列表（>20 个）稳定性 | Opus 4.7 最佳 | GPT-5 最佳 | 中等 | 差 |

实际选型建议：

- **生产首选**：Claude Sonnet 4.6 / GPT-5——速度、质量、价格的平衡点
- **复杂规划场景**：Claude Opus 4.7——长链路工具调用最稳定
- **低延迟场景**：Claude Haiku 4.5——但工具数量超过 10 时会变笨，控制好工具列表
- **本地实验**：Ollama 跑 Llama 3.x、Qwen 3.x——能用，但别期望生产级稳定性

## 完整的可运行示例

```typescript
// agent-with-multi-tools.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 三个互相补充的工具
const searchWeb = tool(
  async ({ query }) => {
    // 真实场景调 Tavily 或 SerpAPI
    return JSON.stringify({
      results: [
        { title: `${query} - 维基百科`, url: "https://example.com/1" },
        { title: `${query} - 官方文档`, url: "https://example.com/2" },
      ],
    });
  },
  {
    name: "web_search",
    description: "在互联网搜索最新信息。涉及实时数据、新闻、文档时使用。",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
    }),
  }
);

const calculate = tool(
  async ({ expression }) => {
    try {
      return String(Function(`"use strict"; return (${expression})`)());
    } catch {
      return JSON.stringify({ error: "表达式无效" });
    }
  },
  {
    name: "calculate",
    description: "计算数学表达式。涉及数学运算时使用。",
    schema: z.object({
      expression: z.string().describe("JavaScript 兼容的数学表达式"),
    }),
  }
);

const getCurrentTime = tool(
  async ({ timezone }) => {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "long",
    });
    return formatter.format(new Date());
  },
  {
    name: "get_current_time",
    description: "获取指定时区的当前时间",
    schema: z.object({
      timezone: z
        .string()
        .default("Asia/Shanghai")
        .describe("IANA 时区，如 'Asia/Shanghai'、'America/New_York'"),
    }),
  }
);

// 一次 createAgent 调用，多工具并行
const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [searchWeb, calculate, getCurrentTime],
  systemPrompt:
    "你是一个高效的助手。涉及实时数据时必须调工具，不要凭记忆回答。回答简洁。",
});

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "现在纽约时间几点？另外，帮我搜一下 LangChain.js 1.x 最新特性，再算一下 0.3 * 2025 是多少",
    },
  ],
});

console.log(result.messages.at(-1)?.content);
```

跑一下，模型会在同一轮内并行调用三个工具，然后整合结果。你写的代码里没有任何并发逻辑，没有 `.bindTools()`，没有手写循环——这就是 1.x 抽象层的价值。

## 切换模型的实操

把上面的 agent 从 Claude 切到 GPT，改一行：

```typescript
import { ChatOpenAI } from "@langchain/openai";

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-5", temperature: 0 }),
  tools: [searchWeb, calculate, getCurrentTime],
  systemPrompt: "...",
});
```

或者用字符串：

```typescript
const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",  // 或 "openai:gpt-5"
  tools: [searchWeb, calculate, getCurrentTime],
});
```

字符串写法 LangChain 会按 `provider:model` 自动选择 Chat Model 实例。生产环境我倾向用实例写法，因为可以精细控制 `temperature`、`maxTokens`、Claude 的 `thinking` 模式等参数。

## 小结

LangChain.js 1.x 的统一 Function Calling 模式，核心就一句话：**写一次 tool，传一个数组给 createAgent，跨厂商无差别运行**。

| 要点 | 1.x 做法 |
|------|----------|
| 工具定义 | `tool(fn, { name, description, schema })` |
| 绑定到模型 | 不要 `.bindTools()`，直接 `createAgent({ model, tools })` |
| 选择工具策略 | `tool_choice: "auto" / "required" / { type: "tool", name } / "none"` |
| 并行调用 | 默认开启，`createAgent` 内部 `Promise.all` |
| 跨厂商切换 | 换一个 model 实例，其他不动 |

下一节 [MCP Server 集成](./mcp-server.md) 把工具来源从"应用内部"扩展到"外部 MCP Server"，接入整个 MCP 生态。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
