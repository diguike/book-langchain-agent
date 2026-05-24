---
title: LangSmith Tracing
feishu_url: ""
last_synced: ""
---

> 模块 07 - 可观测性与评估 | 前置知识：[Callback 系统](./callbacks.md)、[createAgent 入门](../05-agent-architecture/create-agent.md)

## 为什么我把 LangSmith 当默认基础设施

一个生产 Agent 出问题时，我要回答的问题是这种：

- 用户上午 11 点那次"查不到订单"的回复是怎么生成的？模型见到了什么 system prompt、什么对话历史、调了哪些工具、每个工具返回了啥？
- 上周这个 query 平均 P95 6 秒，今天怎么变成 18 秒了？是 model 慢还是某个 tool 慢？
- 上线新版 prompt 之后整体 token 消耗涨了 30%，是哪一类请求贡献的？

不上追踪系统的话，这些问题靠 `console.log` 是答不出来的——尤其是多 Agent、多工具、多步骤的场景。[LangSmith](https://smith.langchain.com/) 是 LangChain 官方的可观测性平台，把每一次 Agent 调用渲染成一棵树：根节点是 `createAgent` 的 invoke，子节点是 model 节点、tools 节点，再往下是具体的 LLM 调用和工具执行，每个节点都带输入、输出、耗时、token 用量、错误堆栈。点开就能看，不用自己埋点。

这一节讲怎么把 LangSmith 接上、怎么自定义追踪、怎么用它喂下游的 dataset 和 eval。

## 接入：两行环境变量

LangChain.js 1.x 的追踪集成是开箱即用的。新建一个 LangSmith 账号，到 Settings → API Keys 生成一个 key（前缀 `lsv2_pt_`），然后设两个环境变量：

```bash
# .env
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_pt_xxxxxxxxxxxx
LANGCHAIN_PROJECT=my-agent-prod   # 可选：项目名，缺省就是 default
```

代码里加载一下：

```typescript
// src/index.ts
import "dotenv/config";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "你是一个简洁的助手",
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "北京今天天气" }],
});
```

跑一次，到 [smith.langchain.com](https://smith.langchain.com/) 的对应项目下就能看到一条 trace。整个 `createAgent` 内部的 LangGraph 循环——每次 model 节点的调用、tools 节点的工具执行——全都自动追上了，不用改任何业务代码。

注意 LangChain.js 1.x 的 `langsmith` SDK 升级到 0.3+，跟 0.2 系列在 API 上有一些细节差异（主要是 `Client`、`traceable`、`evaluate` 的签名收紧），下面的代码都按 0.3+ 写。

## 按环境分项目

我习惯每个环境一个项目，dev / staging / prod 互不污染：

```typescript
// src/observability.ts
const env = process.env.NODE_ENV ?? "development";
process.env.LANGCHAIN_PROJECT = `my-agent-${env}`;
```

要在多个项目之间切换，也可以在调用时按需指定：

```typescript
await agent.invoke(input, {
  runName: "OrderQuery",            // 这次调用在 UI 上显示的名字
  tags: ["api", "order"],            // 标签，便于过滤
  metadata: { userId: "u-123", env: "staging" },
});
```

`runName` 和 `tags` 是 trace 检索的高频字段。给关键调用打 `runName`（例如把 `agent.invoke` 改名为 `OrderQuery`、`RefundFlow`），后续排查时按名字筛比按 runId 筛快得多。

## 一个真实的 trace 长什么样

假设我有一个客服 Agent，处理"我上周下的订单 ORD-2026-001 还没收到"。LangSmith 上的 trace 大概是这样的层级（每个节点点开都能看输入输出）：

```
OrderQuery (agent, 4.2s, 2,341 tokens, $0.018)
├─ model (claude-sonnet-4-6, 1.1s, 980 tokens)
│  └─ 输出: tool_calls=[{name: "lookup_order", args: {orderId: "ORD-2026-001"}}]
├─ tools (200ms)
│  └─ lookup_order(orderId="ORD-2026-001")
│     └─ 输出: {status: "shipped", trackingNo: "SF12345"}
├─ model (claude-sonnet-4-6, 0.9s, 1,012 tokens)
│  └─ 输出: tool_calls=[{name: "get_tracking", args: {trackingNo: "SF12345"}}]
├─ tools (1.8s)
│  └─ get_tracking(trackingNo="SF12345")
│     └─ 输出: {status: "in_transit", eta: "2026-05-27"}
└─ model (claude-sonnet-4-6, 0.4s, 349 tokens)
   └─ 输出: "您的订单 ORD-2026-001 已发货，预计 5 月 27 日送达..."
```

每个节点都有：

- **Input / Output**：完整的请求和响应数据
- **Latency**：精确到毫秒
- **Token usage**：input / output / cached tokens（如果模型支持 prompt cache）
- **Cost**：按 model 定价自动算出来的美元成本
- **Error**：失败时的异常堆栈

这是我做生产排查的主战场。

## 给自定义业务逻辑加 trace：@traceable

Agent 内部的 LangGraph 节点是自动追踪的，但如果业务逻辑在 Agent 外面（前置预处理、后置过滤、缓存查询等），就要手动包一层。LangSmith SDK 提供 `traceable`：

```typescript
import { traceable } from "langsmith/traceable";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

// 包装业务入口
export const handleUserMessage = traceable(
  async (userId: string, message: string) => {
    // 1. 前置：用户画像加载（也会成为子 trace）
    const profile = await loadUserProfile(userId);

    // 2. Agent 调用
    const result = await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      { metadata: { userId, tier: profile.tier } }
    );

    // 3. 后置：审计日志
    await writeAuditLog(userId, message, result);

    return result.messages.at(-1)?.content;
  },
  { name: "HandleUserMessage" }
);

const loadUserProfile = traceable(
  async (userId: string) => {
    // 假装去数据库查
    return { tier: "pro", lang: "zh" };
  },
  { name: "LoadUserProfile" }
);
```

`traceable` 包装的函数在被调用时会创建一个根 run（如果没有父 run）或者一个子 run（如果在另一个 traceable 里被调用）。整个调用栈会自动串起来，跨函数也行。

加 metadata / tags：

```typescript
export const handleUserMessage = traceable(
  async (userId: string, message: string) => { /* ... */ },
  {
    name: "HandleUserMessage",
    metadata: { service: "chatbot", version: "2.4" },
    tags: ["api"],
  }
);
```

## 跟 stream API 配合

[流式输出深入](../05-agent-architecture/stream-modes.md) 讲过的 `stream` / `streamEvents`，在 trace 里也是自动记录的。流式调用会在 LangSmith 上呈现为一条完整 trace，每个 token 的产出虽然不展开但总耗时和总用量准确。

```typescript
for await (const [chunk, meta] of agent.stream(
  { messages: [{ role: "user", content: "..." }] },
  {
    streamMode: "messages",
    runName: "ChatStream",
    metadata: { sessionId: "s-456" },
  }
)) {
  // ...
}
```

`runName` 和 `metadata` 同样有效。SSE 推流的整个 lifecycle 会在 LangSmith 上记成一条 trace。

## 采样：高 QPS 场景别全量上传

QPS 上 100 的时候，全量 trace 上传会有两个问题：网络开销、LangSmith 用量配额。一般做采样：

```typescript
function shouldTrace(): boolean {
  // 错误请求 + 慢请求一定追，正常请求按 10% 采样
  return Math.random() < 0.1;
}

await agent.invoke(input, {
  callbacks: shouldTrace() ? undefined /* 走全局环境变量 */ : [],
  // 关键点：传 callbacks: [] 会覆盖全局，断掉这次的追踪
});
```

更精细的策略：失败时回填全量 trace（用 `error_first` 模式），平时只采小比例。LangSmith Python SDK 支持 `tracing_v2_enabled` 上下文管理器，JS 这边目前要靠传空 callbacks 数组覆盖。

## Dataset：从生产 trace 沉淀回归集

LangSmith 的另一半价值在 Dataset。我用它把生产里发现的好/坏例子归档，定期跑回归。

创建 dataset 并添加例子：

```typescript
// src/eval/seed.ts
import { Client } from "langsmith";

const client = new Client();

async function seedDataset() {
  const dataset = await client.createDataset("customer-service-regression", {
    description: "客服 Agent 回归集",
  });

  await client.createExamples({
    datasetId: dataset.id,
    examples: [
      {
        inputs: { message: "我的订单 ORD-001 怎么还没到" },
        outputs: { answer: "已发货，预计明天送达" },
      },
      {
        inputs: { message: "怎么申请退款" },
        outputs: { answer: "在订单详情页点击申请退款..." },
      },
    ],
  });
}
```

从生产 trace 添加到 dataset，三种方式：

1. **UI 操作**：trace 详情页点 "Add to Dataset"，最常用
2. **编程方式**：知道 runId 的情况下批量加
3. **Annotation Queue**：把候选 trace 推到队列，团队成员人工评分后再决定加不加

编程方式从 runId 添加：

```typescript
async function addRunsToDataset(datasetName: string, runIds: string[]) {
  const dataset = await client.readDataset({ datasetName });
  for (const runId of runIds) {
    const run = await client.readRun(runId);
    await client.createExample(run.inputs, run.outputs ?? {}, {
      datasetId: dataset.id,
    });
  }
}
```

Dataset 的实际用法在下一节 [评估方法与指标](./evaluation.md) 展开。

## 真实排查案例：定位"AI 突然不调工具了"

讲一个我自己遇到的事故。一个客服 Agent 上线后某天突然有用户反馈"问什么都瞎编"。LangSmith 上的排查过程：

1. 在 prod 项目筛 `tags: ["api"] AND error=false`，按 user feedback 时间窗过滤，找到那条 trace
2. 点开 trace 看 model 节点的输出——发现模型确实没产出 `tool_calls`，只有纯文本
3. 看 model 节点的 input——发现 system prompt 里被截断了，工具说明只剩半句
4. 往上看：是上游业务代码动态拼 system prompt 时，一个新加的 placeholder 没填，导致字符串提前结束
5. 修复：在 prompt 拼装代码加断言，缺 placeholder 直接抛错

整个过程从用户反馈到定位根因 15 分钟。没有 trace 的话，这种"模型行为看似正常但内部输入坏了"的 bug 几乎不可能在一天内定位。

## 完整接入模板

我项目里通常这样组织：

```typescript
// src/observability.ts
import "dotenv/config";

export function initObservability() {
  const env = process.env.NODE_ENV ?? "development";

  if (!process.env.LANGCHAIN_API_KEY) {
    console.warn("[obs] LANGCHAIN_API_KEY 未设置，追踪将不上报");
    process.env.LANGCHAIN_TRACING_V2 = "false";
    return;
  }

  process.env.LANGCHAIN_TRACING_V2 = "true";
  process.env.LANGCHAIN_PROJECT = `my-agent-${env}`;
  console.log(`[obs] LangSmith tracing enabled, project=my-agent-${env}`);
}
```

```typescript
// src/agent.ts
import { initObservability } from "./observability";
initObservability();

import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { traceable } from "langsmith/traceable";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

export const handleUserMessage = traceable(
  async (userId: string, message: string) => {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      {
        runName: "ChatTurn",
        metadata: { userId },
        tags: ["api"],
      }
    );
    return result.messages.at(-1)?.content;
  },
  { name: "HandleUserMessage" }
);
```

调用：

```typescript
const answer = await handleUserMessage("u-123", "我的订单怎么还没到");
// LangSmith 上能看到完整两层 trace：HandleUserMessage → ChatTurn → ...
```

## 小结

LangSmith 是 LangChain.js 1.x 生态下默认的可观测性方案，两个环境变量就接上，所有 `createAgent` / `model.invoke` / `agent.stream` 自动追踪。生产排查靠它定位"输入到底是什么"的问题，dataset 用来沉淀回归集，evaluation 跑批量评估。`traceable` 把自定义业务函数也纳入 trace 树。

下一节 [评估方法与指标](./evaluation.md) 讲怎么用 LangSmith 的 dataset 和 evaluator 系统化跑评估，把"感觉好像变好了"变成"correctness 从 0.78 提升到 0.86"。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
