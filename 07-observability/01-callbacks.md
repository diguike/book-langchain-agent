---
title: Callback 系统
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/BdV6woR5ZiDMiTkWfyqcOA5Mn0d"
last_synced: "2026-05-25T02:42:53+08:00"
---

> 模块 07 - 可观测性与评估 | 前置知识：[createAgent 入门](../05-agent-architecture/01-create-agent.md)、[流式输出深入](../05-agent-architecture/10-stream-modes.md)

## 1.x 里 Callback 还重要吗

LangChain.js 1.x 的可观测性主战场是 [LangSmith](https://smith.langchain.com/)：设两个环境变量就拿到全链路 trace，下一节会讲。Callback 系统这一层没消失——它仍然是 LangChain 全栈的事件总线，模型调用、Chain 执行、Tool 执行、Retriever 等所有组件都会在生命周期的关键节点上触发 callback。LangSmith 本身就是一个内置的 callback handler。

那为什么我要专门写一节？因为有些场景 LangSmith 不能直接覆盖：

- 我想把 LLM 用量推到自家 [OpenTelemetry](https://opentelemetry.io/) Collector，跟业务 trace 关联
- 我想暴露 Prometheus 指标给 Grafana 做告警
- 我想把每次模型调用写到内部审计日志库，不能走 SaaS
- 我想在内部计费系统里实时累加 token 成本

这些都靠自定义 `BaseCallbackHandler`。这一节讲怎么写。

## 一个最小的 handler

每个 handler 都继承 `BaseCallbackHandler`，覆写需要的事件方法：

```typescript
// handler-min.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";

class MinHandler extends BaseCallbackHandler {
  name = "MinHandler";

  // 模型调用开始
  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string
  ): Promise<void> {
    console.log(`[llm start] runId=${runId} model=${llm.id?.at(-1)}`);
  }

  // 模型调用结束（一次性返回时触发，流式则在最后一个 token 之后触发）
  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const usage = output.llmOutput?.tokenUsage;
    console.log(`[llm end] runId=${runId} usage=${JSON.stringify(usage)}`);
  }

  // 工具调用开始
  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string
  ): Promise<void> {
    console.log(`[tool start] ${tool.id?.at(-1)} input=${input}`);
  }

  // 工具调用结束
  async handleToolEnd(output: string, runId: string): Promise<void> {
    console.log(`[tool end] output=${output.slice(0, 80)}`);
  }
}
```

挂到一个 Agent 上：

```typescript
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

// runtime callbacks：仅本次调用生效，会向下传递给所有子组件
await agent.invoke(
  { messages: [{ role: "user", content: "..." }] },
  { callbacks: [new MinHandler()] }
);
```

跑一次能看到 `llm start → tool start → tool end → llm start → llm end` 这条完整链路的日志。

## 完整的事件列表

`BaseCallbackHandler` 提供的可覆写方法，按组件分组：

| 组件 | 事件方法 | 说明 |
|------|----------|------|
| LLM / Chat Model | `handleLLMStart` | 模型调用开始 |
|  | `handleLLMNewToken` | 流式每个 token（仅流式调用时触发） |
|  | `handleLLMEnd` | 模型调用结束 |
|  | `handleLLMError` | 模型调用报错 |
| Chain (含 LangGraph 节点) | `handleChainStart` / `handleChainEnd` / `handleChainError` | 链 / 节点级生命周期 |
| Tool | `handleToolStart` / `handleToolEnd` / `handleToolError` | 工具生命周期 |
| Retriever | `handleRetrieverStart` / `handleRetrieverEnd` | 检索生命周期 |
| Custom | `handleCustomEvent` | 业务自定义事件（与 `dispatchCustomEvent` 配套） |

参数签名都长这样：`(具体载荷, runId, parentRunId?, tags?, metadata?, ...)`。其中 `runId` 是当前 run 的 UUID，`parentRunId` 用于把子 run 关联到父 run（比如 Agent 内部的 model 调用，`parentRunId` 就是 Agent 的 runId）。

## 计费 handler：把 token 转成钱

最常见的需求：实时累计每次调用的费用，超阈值告警。

```typescript
// billing-handler.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";

// 每 1M token 美元定价（按 2026-05 当下行情）
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "gpt-5": { input: 5, output: 20 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

interface UsageRecord {
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  ts: number;
}

export class BillingHandler extends BaseCallbackHandler {
  name = "BillingHandler";
  private currentModel = new Map<string, string>(); // runId -> model
  private records: UsageRecord[] = [];

  async handleLLMStart(llm: Serialized, _prompts: string[], runId: string) {
    // 从 Serialized 里取模型名，不同 provider 字段位置略有差异
    const model =
      (llm.kwargs?.model as string) ||
      (llm.kwargs?.modelName as string) ||
      "unknown";
    this.currentModel.set(runId, model);
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const model = this.currentModel.get(runId) ?? "unknown";
    this.currentModel.delete(runId);

    const usage = output.llmOutput?.tokenUsage;
    if (!usage) return;

    const price = PRICING[model];
    if (!price) {
      console.warn(`[billing] no pricing for model ${model}`);
      return;
    }

    const cost =
      (usage.promptTokens * price.input +
        usage.completionTokens * price.output) /
      1_000_000;

    const record: UsageRecord = {
      runId,
      model,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cost,
      ts: Date.now(),
    };
    this.records.push(record);

    // 超阈值告警（示例：单次超过 $1 报警）
    if (cost > 1) {
      console.warn(
        `[billing] HIGH COST runId=${runId} model=${model} cost=$${cost.toFixed(4)}`
      );
    }
  }

  getTotalCost() {
    return this.records.reduce((sum, r) => sum + r.cost, 0);
  }

  flush() {
    const r = [...this.records];
    this.records = [];
    return r;
  }
}
```

挂载方式有两种，差别要分清楚：

```typescript
// 方式 A：构造时挂（constructor callbacks）—— 对该组件的所有调用生效，但不向下传递
const billing = new BillingHandler();
const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  callbacks: [billing],
});

// 方式 B：运行时挂（runtime callbacks）—— 仅本次调用生效，向下传递给所有子组件
await agent.invoke(input, { callbacks: [billing] });
```

差别：

| 维度 | constructor | runtime |
|------|-------------|---------|
| 作用范围 | 该组件所有调用 | 单次调用 |
| 向下传递 | 不传递 | 传递给所有子组件 |
| 典型用途 | 全局计费、模型级日志 | 请求级追踪、单次审计 |

**踩坑提示**：如果你只在 `ChatAnthropic` 实例上挂 `BillingHandler`，那 Agent 调用工具时的子 model 调用（比如多 Agent 协作里的另一个模型）就不会触发你的 handler。要全局都接到，要么把 handler 挂在每个 model 实例上，要么在每次 `agent.invoke` 时通过 runtime callbacks 传入。

## 延迟监控 handler

```typescript
// latency-handler.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

export class LatencyHandler extends BaseCallbackHandler {
  name = "LatencyHandler";
  private starts = new Map<string, number>();

  async handleLLMStart(_llm: unknown, _prompts: string[], runId: string) {
    this.starts.set(`llm:${runId}`, Date.now());
  }

  async handleLLMEnd(_output: unknown, runId: string) {
    const start = this.starts.get(`llm:${runId}`);
    if (!start) return;
    const ms = Date.now() - start;
    this.starts.delete(`llm:${runId}`);
    if (ms > 10_000) {
      console.warn(`[latency] LLM ${runId} took ${ms}ms (> 10s)`);
    }
  }

  async handleToolStart(_tool: unknown, _input: string, runId: string) {
    this.starts.set(`tool:${runId}`, Date.now());
  }

  async handleToolEnd(_output: string, runId: string) {
    const start = this.starts.get(`tool:${runId}`);
    if (!start) return;
    const ms = Date.now() - start;
    this.starts.delete(`tool:${runId}`);
    if (ms > 30_000) {
      console.warn(`[latency] Tool ${runId} took ${ms}ms (> 30s)`);
    }
  }
}
```

注意 `runId` 本身是 UUID、全局唯一，同一个 runId 会同时出现在 `handleLLMStart` 和 `handleLLMEnd`。这里加 `llm:` / `tool:` 前缀只是为了让 key 一眼能看出归属哪个组件，调试时翻 Map 更直观；直接用裸 `runId` 做 key 也完全成立。

## 导出到 OpenTelemetry

如果团队已经有 OTel 基础设施，把 LangChain 事件转成 OTel Span 就能跟其他服务的 trace 串起来：

```typescript
// otel-handler.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { trace, type Span, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("langchain-agent");

export class OTelHandler extends BaseCallbackHandler {
  name = "OTelHandler";
  private spans = new Map<string, Span>();

  async handleLLMStart(llm: Serialized, prompts: string[], runId: string) {
    const span = tracer.startSpan("llm.call", {
      attributes: {
        "llm.model":
          (llm.kwargs?.model as string) ||
          (llm.kwargs?.modelName as string) ||
          "unknown",
        "llm.prompt.chars": prompts.reduce((s, p) => s + p.length, 0),
      },
    });
    this.spans.set(runId, span);
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const span = this.spans.get(runId);
    if (!span) return;
    const usage = output.llmOutput?.tokenUsage;
    if (usage) {
      span.setAttribute("llm.tokens.input", usage.promptTokens ?? 0);
      span.setAttribute("llm.tokens.output", usage.completionTokens ?? 0);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.spans.delete(runId);
  }

  async handleLLMError(err: Error, runId: string) {
    const span = this.spans.get(runId);
    if (!span) return;
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    this.spans.delete(runId);
  }

  async handleToolStart(tool: Serialized, input: string, runId: string) {
    const span = tracer.startSpan("tool.call", {
      attributes: {
        "tool.name": (tool.id?.at(-1) as string) || "unknown",
        "tool.input.chars": input.length,
      },
    });
    this.spans.set(runId, span);
  }

  async handleToolEnd(output: string, runId: string) {
    const span = this.spans.get(runId);
    if (!span) return;
    span.setAttribute("tool.output.chars", output.length);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.spans.delete(runId);
  }
}
```

这只是单次 trace 的 span。OTel 的 context propagation（跨进程 trace ID 传递）需要在 HTTP/RPC 层做配套设置，参考 [OpenTelemetry JS 文档](https://opentelemetry.io/docs/languages/js/)。

## 导出到 Prometheus

Prometheus 是 pull 模型——你在进程里维护 counter / histogram，暴露一个 `/metrics` 端点让 Prometheus 来抓。

```typescript
// prom-handler.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { Counter, Histogram } from "prom-client";

const llmRequests = new Counter({
  name: "llm_requests_total",
  help: "LLM 调用次数",
  labelNames: ["model", "status"],
});

const llmTokens = new Counter({
  name: "llm_tokens_total",
  help: "LLM token 累计消耗",
  labelNames: ["model", "type"], // type=input/output
});

const llmLatency = new Histogram({
  name: "llm_request_duration_seconds",
  help: "LLM 调用耗时",
  labelNames: ["model"],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
});

export class PromHandler extends BaseCallbackHandler {
  name = "PromHandler";
  private starts = new Map<string, { model: string; ts: number }>();

  async handleLLMStart(llm: Serialized, _prompts: string[], runId: string) {
    const model =
      (llm.kwargs?.model as string) ||
      (llm.kwargs?.modelName as string) ||
      "unknown";
    this.starts.set(runId, { model, ts: Date.now() });
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const ctx = this.starts.get(runId);
    if (!ctx) return;
    this.starts.delete(runId);

    const seconds = (Date.now() - ctx.ts) / 1000;
    llmLatency.labels(ctx.model).observe(seconds);
    llmRequests.labels(ctx.model, "ok").inc();

    const usage = output.llmOutput?.tokenUsage;
    if (usage) {
      llmTokens.labels(ctx.model, "input").inc(usage.promptTokens ?? 0);
      llmTokens.labels(ctx.model, "output").inc(usage.completionTokens ?? 0);
    }
  }

  async handleLLMError(_err: Error, runId: string) {
    const ctx = this.starts.get(runId);
    if (!ctx) return;
    this.starts.delete(runId);
    llmRequests.labels(ctx.model, "error").inc();
  }
}
```

暴露端点（用 Hono 举例）：

```typescript
import { Hono } from "hono";
import { register } from "prom-client";

const app = new Hono();
app.get("/metrics", async (c) => {
  c.header("Content-Type", register.contentType);
  return c.text(await register.metrics());
});
```

Prometheus 配置（`scrape_configs`）指向 `your-app:3000/metrics` 即可。Grafana 仪表盘的 PromQL 示例：

```
# 每分钟 token 消耗（按模型分组）
rate(llm_tokens_total[1m])

# p95 延迟
histogram_quantile(0.95, rate(llm_request_duration_seconds_bucket[5m]))

# 错误率
rate(llm_requests_total{status="error"}[5m]) / rate(llm_requests_total[5m])
```

## Callback 与自定义事件

[流式输出深入](../05-agent-architecture/10-stream-modes.md) 提到 `dispatchCustomEvent` 可以从 tool 或 middleware 里发自定义事件给消费端。这些事件同样能被 callback handler 捕获：

```typescript
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

class CustomEventHandler extends BaseCallbackHandler {
  name = "CustomEventHandler";

  async handleCustomEvent(
    eventName: string,
    payload: unknown,
    runId: string
  ): Promise<void> {
    console.log(`[custom] ${eventName} runId=${runId}`, payload);
  }
}
```

业务进度（"正在下载 80%"）这种场景，如果想同时推给前端和后台监控，custom event 是最干净的方案：前端用 `streamMode: "custom"` 拿，后台用 callback 转写到日志。

## Constructor vs Runtime：实战选择

我自己的项目里通常这样分工：

- **全局 model 实例上**挂 `BillingHandler` / `PromHandler` —— 这些是产品级 SLO 指标，应该所有调用都统计，少一次就漏一次成本
- **`agent.invoke` 调用时**挂 `OTelHandler` —— OTel span 要绑定 HTTP 请求的 trace context，必须按请求传入
- **CLI 调试时**挂 `ConsoleCallbackHandler`（内置）—— 临时挂一下看链路，不污染生产代码

注意一个细节：constructor callbacks **不会向下传递**。如果你只在 `ChatAnthropic` 上挂了一个 Prometheus handler，那 Agent 里 `tools` 节点的事件（`handleToolStart` / `handleToolEnd`）这个 handler 是收不到的，因为它没挂在 tools 这一侧。要拿到工具事件就要在 `agent.invoke` 时通过 runtime callbacks 传——runtime callbacks 会顺着调用栈往下传到每一个子组件。

## 跟 LangSmith 怎么并存

LangSmith 自己就是一个 callback handler（环境变量 `LANGCHAIN_TRACING_V2=true` 时自动注册）。你写的自定义 handler 跟它并存，不冲突——所有 handler 都会被同一个事件依次触发。

实践配置：

```typescript
// src/observability.ts
import { BillingHandler } from "./handlers/billing-handler";
import { PromHandler } from "./handlers/prom-handler";

export const globalHandlers = [
  new BillingHandler(),
  new PromHandler(),
];

// LangSmith 走环境变量自动注册，不用在代码里出现
```

```typescript
// src/agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { globalHandlers } from "./observability";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  callbacks: globalHandlers,
});

export const agent = createAgent({ model, tools: [/* ... */], systemPrompt: "..." });
```

LangSmith 拿到完整 trace 用于业务调试，Prometheus 拿到聚合指标用于 SRE 告警，BillingHandler 拿到成本数据写到自家计费库。三套同时跑，互不干扰。

## 小结

LangChain.js 1.x 的可观测性优先用 LangSmith，但 callback 系统仍然是把事件流引到自家基础设施（OTel / Prometheus / 内部计费）的标准接口。自定义 handler 继承 `BaseCallbackHandler`，覆写需要的事件方法，构造时挂全局指标、运行时挂请求级追踪。runId 是关联 start/end 的唯一标识，要妥善管理生命周期避免内存泄漏。

下一节 [LangSmith Tracing](./02-langsmith-tracing.md) 看怎么用 LangSmith 拿到开箱即用的全链路追踪能力。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
