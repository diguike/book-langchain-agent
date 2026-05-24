---
title: ReAct 模式
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/PMyYwpIUqiXmtRkC9xMcHEYAnge"
last_synced: "2026-05-25T02:41:58+08:00"
---

> 模块 05 - Agent 架构 | 前置知识：[createAgent 入门](./create-agent.md)

## ReAct 是什么

ReAct 的名字是 Reasoning + Acting 的缩写，2022 年由 Yao 等人在 *ReAct: Synergizing Reasoning and Acting in Language Models* 里提出。一句话概括：**让模型在"思考"和"行动"之间交替进行，每一次行动的结果会反过来喂给下一轮的思考。**

具体的循环长这样：

```
Thought  →  Action  →  Observation  →  Thought  →  Action  →  Observation  →  ...  →  Final Answer
```

| 阶段 | 含义 |
|------|------|
| Thought | 模型内部推理：当前需要做什么、下一步该调哪个工具 |
| Action | 选一个工具、给它合适的参数 |
| Observation | 工具返回的结果 |
| Final Answer | 收集到足够信息后给出最终回答 |

我在 [createAgent 入门](./create-agent.md) 里说过，`createAgent` 内部就是一张 `model ↔ tools` 的 LangGraph 图。这张图跑的就是 ReAct 循环——模型节点输出一条带 `tool_calls` 的消息，工具节点执行、把结果回灌成 `ToolMessage`，模型节点再读这条新消息决定下一步。

换句话说，**用 `createAgent` 创建出来的 Agent 默认就是 ReAct Agent**。这一节要讲的是怎么让这个循环里的"thinking"真正可见——以及怎么调它。

## 跟 Chain-of-Thought 的区别

新手很容易混淆 ReAct 和 Chain-of-Thought（CoT）。差别就一条：**是否跟外部世界交互**。

| 维度 | CoT | ReAct |
|------|-----|-------|
| 核心能力 | 纯推理（只有 Thought） | 推理 + 行动 |
| 外部交互 | 无 | 有，可以调工具拿到实时数据 |
| 信息来源 | 模型训练数据 | 训练数据 + 外部工具返回 |
| 幻觉风险 | 高（不能验证） | 低（可用工具验证） |

CoT 让模型"想清楚"，ReAct 让模型"想清楚再去干"。当任务涉及任何需要外部信息或副作用的事情（查数据、调 API、写文件），就该走 ReAct。

## 第一个 ReAct Agent

直接用 `createAgent` 写一个"搜索 + 计算"的多步推理 Agent：

```typescript
// react-agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 工具 1：模拟搜索
const webSearch = tool(
  async ({ query }) => {
    // 真实场景接 Tavily / SerpAPI
    const fixtures: Record<string, string> = {
      apple: "苹果公司 2025 财年总营收为 4123 亿美元",
      microsoft: "微软公司 2025 财年总营收为 2810 亿美元",
    };
    if (query.includes("苹果") || query.toLowerCase().includes("apple")) {
      return fixtures.apple;
    }
    if (query.includes("微软") || query.toLowerCase().includes("microsoft")) {
      return fixtures.microsoft;
    }
    return `未找到与"${query}"相关的数据`;
  },
  {
    name: "web_search",
    description: "从互联网搜索公开信息，输入中英文关键词，返回一段事实性描述",
    schema: z.object({
      query: z.string().describe("搜索关键词，如 '苹果 2025 营收'"),
    }),
  }
);

// 工具 2：数学计算
const calculator = tool(
  async ({ expression }) => {
    // 生产请用 mathjs / expr-eval，这里仅做演示
    const value = Function(`"use strict"; return (${expression})`)();
    return `${expression} = ${value}`;
  },
  {
    name: "calculator",
    description: "执行一个 JavaScript 风格的数学表达式，返回数值结果",
    schema: z.object({
      expression: z.string().describe("如 '4123 / 2810'"),
    }),
  }
);

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [webSearch, calculator],
  systemPrompt: `你是一个研究分析助手。回答跟事实/数据有关的问题时，必须先用 web_search 获取信息，再用 calculator 做计算，最后给出简短结论。不要凭记忆回答。`,
});

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "苹果 2025 财年的营收是微软的多少倍？",
    },
  ],
});

console.log(result.messages.at(-1)?.content);
// 期望输出类似：苹果约为微软的 1.47 倍（4123 / 2810 ≈ 1.467）。
```

跑起来：

```bash
ANTHROPIC_API_KEY=sk-ant-xxx npx tsx react-agent.ts
```

模型自己决定了执行顺序——先搜苹果、再搜微软、再算除法、最后总结。这个调度过程我没写一行控制代码。

## 让 ReAct 的 thinking 可见

`invoke` 只给最终结果。要"看见"模型每一步在想什么、调了哪个工具、拿到什么观察值，得用 `stream`。

`streamMode: "updates"` 推每个节点产出的增量更新——这正好对应 ReAct 循环里的每一步：

```typescript
// react-trace.ts
const stream = await agent.stream(
  {
    messages: [{ role: "user", content: "苹果 2025 财年的营收是微软的多少倍？" }],
  },
  { streamMode: "updates" }
);

for await (const update of stream) {
  // update 形如 { 节点名: { messages: [...] } }
  for (const [nodeName, payload] of Object.entries(update)) {
    const messages = (payload as { messages?: unknown[] }).messages ?? [];
    for (const msg of messages as Array<Record<string, unknown>>) {
      // 模型节点：输出 thinking + tool_calls
      if (nodeName === "model") {
        const toolCalls = msg.tool_calls as Array<{ name: string; args: unknown }> | undefined;
        if (toolCalls?.length) {
          console.log(
            `[thought → action] ${toolCalls
              .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
              .join(", ")}`
          );
        } else {
          // 没有工具调用，就是最终回答
          const text = extractText(msg.contentBlocks ?? msg.content);
          console.log(`[final answer] ${text}`);
        }
      }
      // 工具节点：输出 observation
      if (nodeName === "tools") {
        const text = extractText(msg.content);
        console.log(`[observation] ${text}`);
      }
    }
  }
}

// 兼容 1.x 多模态：contentBlocks 优先，回退到 content
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" ? block.text ?? "" : ""
      )
      .join("");
  }
  return "";
}
```

跑出来大概是这样：

```
[thought → action] web_search({"query":"苹果 2025 财年营收"})
[observation] 苹果公司 2025 财年总营收为 4123 亿美元
[thought → action] web_search({"query":"微软 2025 财年营收"})
[observation] 微软公司 2025 财年总营收为 2810 亿美元
[thought → action] calculator({"expression":"4123 / 2810"})
[observation] 4123 / 2810 = 1.4672...
[final answer] 苹果 2025 财年营收约为微软的 1.47 倍。
```

这就是 ReAct 循环的完整轨迹。`thought` 隐含在模型对"该调哪个工具"的选择里，`action` 是工具调用，`observation` 是工具返回。

更精细的流式选项——比如 token-by-token 推模型生成、或者按业务自定义事件——见 [流式输出深入](./stream-modes.md)。

## ReAct 走弯路时怎么调

ReAct 是"边想边做"的贪心策略，有几个典型病灶：

### 1. 工具描述不到位，模型选错工具

模型完全凭 `name` 和 `description` 决定要不要用某个工具。如果描述太泛（如 `"做计算"`），它很容易在不该用计算器的场景调它，或者在该用的时候不调。

修正：description 写清楚"什么场景下用、参数怎么填、返回什么"。

```typescript
// 模糊
description: "搜索"

// 清晰
description: "从公开互联网搜索事实信息。输入是中文或英文关键词，返回一段 1-3 句话的描述。**不要**用它做计算。"
```

### 2. 模型陷入循环

ReAct 没有全局规划，遇到工具返回空结果就可能反复调同一个工具改参数。生产环境必须设上限：

```typescript
await agent.invoke(
  { messages: [{ role: "user", content: "..." }] },
  { recursionLimit: 25 } // 默认 25 步，超过就抛 GraphRecursionError
);
```

如果某个任务经常撞到 25 步上限，那它就不该用 ReAct，应该改用 [Plan-and-Execute](./plan-and-execute.md)——先规划再执行，避免在子任务上空转。

### 3. 模型不调工具，直接编答案

最常见的失败模式。三个原因：

- description 不够清楚（见上面第 1 点）
- systemPrompt 没强调"必须用工具"——直接在 prompt 里写"涉及实时数据时必须先调工具，不要凭记忆回答"
- 模型能力不够——Haiku 4.5 在长工具列表（>8 个）下容易选错，复杂场景换 Sonnet 4.6 或 Claude Opus 4.7

调试这种问题最快的方式是接 [LangSmith](../07-observability/langsmith-tracing.md)，每一次调用都能可视化看到模型选了哪些工具。

## ReAct 适合什么、不适合什么

适合：

- **2 到 4 步的工具编排**：查 → 算 → 总结、检索 → 过滤 → 回答
- **决策路径不确定**：模型需要根据中间结果决定下一步调谁
- **简单的多源信息整合**：搜多个 API、合并结果

不适合：

- **5+ 步的复杂任务**：ReAct 没有全局视野，走弯路概率大。换 [Plan-and-Execute](./plan-and-execute.md)
- **输出质量要求高的写作**：单次生成质量不稳定，需要套一层 Critic。换 [Self-Reflection](./self-reflection.md)
- **多专家协作**：单个 Agent 工具太多 prompt 会爆炸。换 [Multi-Agent](./multi-agent.md)
- **高风险操作**：删数据、转账，必须有人工审批。换 [Human-in-the-Loop](./human-in-the-loop.md)

## 小结

ReAct 是 Agent 最基础的循环模式，思路是 thought → action → observation 不断交替。在 LangChain.js 1.x 里，`createAgent` 创建出来的 Agent 默认就是 ReAct——`model ↔ tools` 的 LangGraph 状态机。

要观察循环里的每一步，用 `stream({ streamMode: "updates" })`，按节点名（`model` / `tools`）拆开看 thought + action 和 observation。生产环境记得设 `recursionLimit`，并把工具 description 写到足够清楚。

下一节 [Plan-and-Execute](./plan-and-execute.md) 处理 ReAct 处理不了的复杂多步任务。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
