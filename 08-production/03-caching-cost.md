---
title: 缓存与成本优化
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/SgEXwWbD8iuGqikHtV0cIJ3nnbg"
last_synced: "2026-05-25T02:43:14+08:00"
---

> 模块 08 - 生产部署 | 前置知识：[Callback 系统](../07-observability/01-callbacks.md)、[API 服务化](./01-api-server.md)

## 一笔账：LLM 成本是怎么烧出来的

我的一个客服 Agent 项目第一个月 LLM 账单 ¥18,000，第二个月做完优化降到 ¥6,200。降的不是请求量——QPS 还涨了 30%。优化做的事很朴素：

1. **缓存能命中的尽量命中**：精确缓存 + 语义缓存
2. **能开 prompt cache 就开**：Anthropic / OpenAI 都原生支持
3. **模型按难度路由**：90% 的查询其实 Haiku 4.5 / GPT-4o-mini 就能答好
4. **Token 用量监控 + 异常告警**：找到吞 token 大户的 case 重点优化

这一节按这个顺序展开。先看下当前主流模型的定价数量级（2026-05），用来算账：

| 模型 | 输入 ($/1M tokens) | 输出 ($/1M tokens) | 适用 |
|------|--------------------|--------------------|------|
| Claude Opus 4.7 | 15 | 75 | 复杂推理 / 长文档规划 |
| Claude Sonnet 4.6 | 3 | 15 | 大多数 Agent 工作负载 |
| Claude Haiku 4.5 | 0.8 | 4 | 路由 / 分类 / 简单 QA |
| GPT-5 | 5 | 20 | 旗舰推理 |
| GPT-4o | 2.5 | 10 | 平衡选择 |
| GPT-4o-mini | 0.15 | 0.6 | 低成本场景 |

成本估算公式：

```
月成本 ≈ QPS × 86400 × 30 × (in_tokens × in_price + out_tokens × out_price) / 1_000_000
```

例：QPS=10，每次平均 input 2000 / output 500 tokens，全用 Sonnet 4.6：

```
10 × 86400 × 30 × (2000 × 3 + 500 × 15) / 1_000_000
= 25,920,000 × 13.5 / 1_000_000
≈ $350,000 / 月
```

听着夸张，但日活 100 万的产品 QPS 10 是合理的——所以优化才有必要。

## 精确缓存：相同输入直接命中

最简单也最有效的优化：完全相同的输入直接返回上次的输出，不调模型。适合 temperature=0 的场景（输出确定）。

```typescript
// src/cache/exact-cache.ts
import { createClient, type RedisClientType } from "redis";
import crypto from "crypto";

interface CacheKey {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  tools?: string[]; // 工具列表也算 key 的一部分
}

export class ExactCache {
  private redis: RedisClientType;
  private ttl: number;

  constructor(redisUrl: string, ttlSeconds = 3600) {
    this.redis = createClient({ url: redisUrl });
    this.ttl = ttlSeconds;
  }

  async connect() {
    await this.redis.connect();
  }

  private hashKey(payload: CacheKey): string {
    const json = JSON.stringify(payload);
    const hash = crypto.createHash("sha256").update(json).digest("hex");
    return `llm:exact:${hash}`;
  }

  async get(payload: CacheKey): Promise<string | null> {
    const v = await this.redis.get(this.hashKey(payload));
    if (v) console.log("[exact-cache] HIT");
    return v;
  }

  async set(payload: CacheKey, response: string): Promise<void> {
    await this.redis.setEx(this.hashKey(payload), this.ttl, response);
  }
}
```

包装 Agent 调用：

```typescript
import { agent } from "./lib/agent";
import { ExactCache } from "./cache/exact-cache";

const cache = new ExactCache(process.env.REDIS_URL!);
await cache.connect();

async function cachedInvoke(message: string) {
  const key = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: message }],
    temperature: 0,
  };

  const cached = await cache.get(key);
  if (cached) return cached;

  const result = await agent.invoke({
    messages: [{ role: "user", content: message }],
  });
  const answer = result.messages.at(-1)?.content as string;

  await cache.set(key, answer);
  return answer;
}
```

适用场景判断：

- **适合**：FAQ 类客服、文档查询、模板化生成（产品描述生成器）
- **不适合**：有用户上下文的对话（threadId 不同就不该共享缓存）、temperature > 0 的创作场景

命中率经验值：FAQ 场景能到 30-40%，开放对话 5-10%。

## 语义缓存：相似输入也能命中

"我的订单怎么还没到" 和 "我下的单到哪了" 字面不同但意思一样，精确缓存命中不了。语义缓存用 embedding 做相似度匹配：把问题转向量、跟历史 query 比 cosine similarity、相似度高于阈值就返回缓存。

简单实现：

```typescript
// src/cache/semantic-cache.ts
import { OpenAIEmbeddings } from "@langchain/openai";
import { createClient, type RedisClientType } from "redis";

interface SemanticEntry {
  query: string;
  embedding: number[];
  response: string;
  ts: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class SemanticCache {
  private redis: RedisClientType;
  private embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });
  private threshold: number;
  private ttlMs: number;
  private listKey = "semantic_cache:list";

  constructor(redisUrl: string, opts: { threshold?: number; ttlSeconds?: number } = {}) {
    this.redis = createClient({ url: redisUrl });
    this.threshold = opts.threshold ?? 0.92;
    this.ttlMs = (opts.ttlSeconds ?? 7200) * 1000;
  }

  async connect() {
    await this.redis.connect();
  }

  async lookup(query: string): Promise<string | null> {
    const qEmb = await this.embeddings.embedQuery(query);
    const items = await this.redis.lRange(this.listKey, 0, -1);

    let best: SemanticEntry | null = null;
    let bestSim = 0;
    const now = Date.now();

    for (const s of items) {
      const e: SemanticEntry = JSON.parse(s);
      if (now - e.ts > this.ttlMs) continue;
      const sim = cosine(qEmb, e.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = e;
      }
    }

    if (best && bestSim >= this.threshold) {
      console.log(`[semantic-cache] HIT sim=${bestSim.toFixed(3)} q="${best.query.slice(0, 30)}"`);
      return best.response;
    }
    return null;
  }

  async store(query: string, response: string): Promise<void> {
    const embedding = await this.embeddings.embedQuery(query);
    const entry: SemanticEntry = { query, embedding, response, ts: Date.now() };
    await this.redis.lPush(this.listKey, JSON.stringify(entry));
    // 限制大小，保留最近 5000 条
    await this.redis.lTrim(this.listKey, 0, 4999);
  }
}
```

阈值经验值：

- 0.95+：极保守，只有几乎同义才命中，准确度高但命中率低
- 0.90-0.94：平衡区，生产用得多
- < 0.90：激进，可能错误命中

实际部署要做**双阶段校验**：相似度阈值过了之后，让一个小模型快速判断"原 query 的答案是否适用于新 query"。这样既扩大命中又控制错误率：

```typescript
async function shouldUseCache(originalQuery: string, newQuery: string, cachedAnswer: string) {
  const judge = new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 });
  const result = await judge.invoke([
    {
      role: "system",
      content: `判断针对 "原问题" 的回答是否适用于回答 "新问题"。只回答 yes 或 no。`,
    },
    {
      role: "user",
      content: `原问题：${originalQuery}\n新问题：${newQuery}\n回答：${cachedAnswer}`,
    },
  ]);
  return /yes/i.test(result.content as string);
}
```

判断成本（Haiku 4.5 几百 token）远低于完整 Agent 调用，性价比划算。

### 生产推荐：Redis Vector Search

线性扫描在缓存超过几千条之后性能塌方。生产用 Redis Stack 的向量索引（HNSW）：

```typescript
// 创建索引（仅首次）
await redis.ft.create(
  "idx:llm_cache",
  {
    embedding: {
      type: "VECTOR",
      ALGORITHM: "HNSW",
      TYPE: "FLOAT32",
      DIM: 1536,                       // text-embedding-3-small 维度
      DISTANCE_METRIC: "COSINE",
    },
    query: { type: "TEXT" },
    response: { type: "TEXT" },
  },
  { ON: "HASH", PREFIX: "cache:" }
);

// 查询 top-1
const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
const res = await redis.ft.search(
  "idx:llm_cache",
  "*=>[KNN 1 @embedding $B AS score]",
  {
    PARAMS: { B: buf },
    SORTBY: "score",
    DIALECT: 2,
    RETURN: ["response", "score"],
  }
);
```

数百万条缓存毫秒级响应。

## Prompt Cache：厂商原生支持

Anthropic 和 OpenAI 都提供 prompt cache——把 prompt 的稳定部分（system prompt、长上下文、few-shot 示例）标记为可缓存，下次同样的前缀直接复用，**只对变化部分计费 + 缓存部分 10% 折扣**。

Anthropic 用法（`cache_control` 字段）：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic({ model: "claude-sonnet-4-6" });

// 把长 system prompt 标为可缓存
const result = await model.invoke([
  {
    role: "system",
    content: [
      {
        type: "text",
        text: `[这里是 3000 token 的长 system prompt + few-shot 示例]`,
        cache_control: { type: "ephemeral" }, // 标记为可缓存
      },
    ],
  },
  { role: "user", content: "用户的本次问题" },
]);
```

第一次调用：3000 输入 token 全价，写入 cache。
之后 5 分钟内：3000 token 按 10% 计费（约 90% 折扣），新增的 user message 全价。

OpenAI 是自动 prompt cache（不用手动标记），prompt 前 1024 token 之后的部分如果重复就自动缓存：

```typescript
const model = new ChatOpenAI({ model: "gpt-4o" });
// 长 system prompt 放最前面，让 prefix 自动命中 cache
```

适用场景：长 system prompt 不变 + 用户消息变化的所有场景。我的客服 Agent system prompt 是 4000 token（含工具说明、few-shot 示例、policy），开 prompt cache 后每次 user input 调用的 input 计费降了 88%。

## 模型路由：简单 query 用便宜模型

90% 的查询其实 Haiku 4.5 / GPT-4o-mini 就能答好，把它们分流出去能省巨多。路由器用最便宜的模型做分类：

```typescript
// src/router/model-router.ts
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";

const RouteDecision = z.object({
  complexity: z.enum(["simple", "moderate", "complex"]),
  reasoning: z.string(),
});

const router = new ChatAnthropic({
  model: "claude-haiku-4-5",
  temperature: 0,
}).withStructuredOutput(RouteDecision);

export async function pickModel(query: string): Promise<string> {
  const decision = await router.invoke([
    {
      role: "system",
      content: `判断查询复杂度：
- simple: 事实查询、是非问题、简单格式转换、单步问答
- moderate: 需要 2-3 步推理、调一两个工具
- complex: 需要深度推理、长上下文规划、多步骤计划

只考虑查询本身的复杂度，不考虑 domain。`,
    },
    { role: "user", content: query },
  ]);

  const map = {
    simple: "claude-haiku-4-5",
    moderate: "claude-sonnet-4-6",
    complex: "claude-opus-4-7",
  };

  console.log(`[router] "${query.slice(0, 30)}" → ${decision.complexity} → ${map[decision.complexity]}`);
  return map[decision.complexity];
}
```

跟 Agent 集成：

```typescript
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

// 每个模型对应一个 Agent 实例
const agents = {
  "claude-haiku-4-5": createAgent({
    model: new ChatAnthropic({ model: "claude-haiku-4-5" }),
    tools: [/* ... */],
    systemPrompt: "...",
  }),
  "claude-sonnet-4-6": createAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
    tools: [/* ... */],
    systemPrompt: "...",
  }),
  "claude-opus-4-7": createAgent({
    model: new ChatAnthropic({ model: "claude-opus-4-7" }),
    tools: [/* ... */],
    systemPrompt: "...",
  }),
};

async function smartInvoke(message: string) {
  const modelName = await pickModel(message);
  return agents[modelName].invoke({
    messages: [{ role: "user", content: message }],
  });
}
```

注意路由本身也要花 token（Haiku 几百 token，约 $0.0001），所以要确认平均成本节省 > 路由开销。我的项目实测：路由器每次约 600 input + 50 output token ≈ $0.0007，但 80% 的请求被路到 Haiku（比 Sonnet 便宜 3.75x），净省 60%。

## Token 用量监控与告警

要砍成本得先看清成本花在哪。结合 [Callback 系统](../07-observability/01-callbacks.md) 里讲的 `BillingHandler`，加一层告警：

```typescript
// src/cost/budget-guard.ts
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "gpt-5": { input: 5, output: 20 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export class BudgetGuard extends BaseCallbackHandler {
  name = "BudgetGuard";
  private hourlyCost = 0;
  private dailyCost = 0;
  private lastHourReset = Date.now();
  private lastDayReset = Date.now();
  private currentModel = new Map<string, string>();

  constructor(
    private hourlyBudgetUsd: number,
    private dailyBudgetUsd: number
  ) {
    super();
  }

  async handleLLMStart(llm: any, _prompts: string[], runId: string) {
    const m = (llm.kwargs?.model as string) || "unknown";
    this.currentModel.set(runId, m);
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const model = this.currentModel.get(runId) ?? "unknown";
    this.currentModel.delete(runId);
    const usage = output.llmOutput?.tokenUsage;
    const price = PRICING[model];
    if (!usage || !price) return;

    const cost =
      (usage.promptTokens * price.input + usage.completionTokens * price.output) /
      1_000_000;

    const now = Date.now();
    if (now - this.lastHourReset > 3600_000) {
      this.hourlyCost = 0;
      this.lastHourReset = now;
    }
    if (now - this.lastDayReset > 86_400_000) {
      this.dailyCost = 0;
      this.lastDayReset = now;
    }
    this.hourlyCost += cost;
    this.dailyCost += cost;

    if (this.hourlyCost > this.hourlyBudgetUsd) {
      console.error(`[budget] HOURLY BUDGET EXCEEDED: $${this.hourlyCost.toFixed(2)}`);
      // 触发告警：发送到 Slack / PagerDuty / 飞书
    }
    if (this.dailyCost > this.dailyBudgetUsd) {
      console.error(`[budget] DAILY BUDGET EXCEEDED: $${this.dailyCost.toFixed(2)}`);
    }
  }

  /** 当前小时或当天累计花费是否已超预算，供 HTTP 网关熔断使用 */
  isOverBudget(): boolean {
    return (
      this.hourlyCost > this.hourlyBudgetUsd ||
      this.dailyCost > this.dailyBudgetUsd
    );
  }
}
```

挂到 model 上：

```typescript
const budgetGuard = new BudgetGuard(50, 1000); // $50/hour, $1000/day

const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  callbacks: [budgetGuard],
});
```

更进一步：超预算后**直接拒绝新请求**而非只告警：

```typescript
import type { Context, Next } from "hono";

export function budgetGate(guard: BudgetGuard) {
  return async (c: Context, next: Next) => {
    if (guard.isOverBudget()) {
      return c.json(
        { ok: false, error: "Service temporarily unavailable due to budget cap" },
        503
      );
    }
    await next();
  };
}
```

## Token 压缩与对话裁剪

长对话的累积成本可以失控——每一轮都把全部历史送回模型，token 平方级增长。

最简单的对策：保留最近 N 轮 + 早期摘要：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

async function compressHistory(
  messages: Array<{ role: string; content: string }>,
  keepRecent = 10
): Promise<Array<{ role: string; content: string }>> {
  if (messages.length <= keepRecent + 1) return messages;

  const system = messages.find((m) => m.role === "system");
  const others = messages.filter((m) => m.role !== "system");
  const early = others.slice(0, -keepRecent);
  const recent = others.slice(-keepRecent);

  const summarizer = new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 });
  const summary = await summarizer.invoke([
    { role: "system", content: "用 2-3 句话总结以下对话的要点，保留所有关键事实。" },
    {
      role: "user",
      content: early.map((m) => `${m.role}: ${m.content}`).join("\n"),
    },
  ]);

  return [
    ...(system ? [system] : []),
    { role: "system" as const, content: `之前对话的摘要：${summary.content}` },
    ...recent,
  ];
}
```

更复杂的做法是用 LangGraph middleware 在 model 节点前自动跑：

```typescript
import { createMiddleware } from "langchain";

const historyCompressionMiddleware = createMiddleware({
  name: "history-compression",
  beforeModel: async (state) => {
    const compressed = await compressHistory(state.messages);
    return { messages: compressed };
  },
});
```

Middleware 写法见 05 模块的 middleware 章节。

## 批量与队列：非实时任务集中处理

非实时任务（数据标注、批量生成、定时报告）走队列，可以充分利用 LLM provider 的 batch API 拿额外折扣：

- OpenAI Batch API：50% 折扣，24 小时内返回
- Anthropic Batch API：50% 折扣

队列用 [BullMQ](https://docs.bullmq.io/)：

```typescript
import { Queue, Worker } from "bullmq";
import { ChatAnthropic } from "@langchain/anthropic";

const queue = new Queue("llm-batch", {
  connection: { host: "localhost", port: 6379 },
});

await queue.addBulk(
  inputs.map((input, i) => ({
    name: `task-${i}`,
    data: { input },
    opts: { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  }))
);

new Worker(
  "llm-batch",
  async (job) => {
    const model = new ChatAnthropic({ model: "claude-haiku-4-5" });
    const result = await model.invoke(job.data.input);
    return result.content;
  },
  {
    connection: { host: "localhost", port: 6379 },
    concurrency: 10,
    limiter: { max: 100, duration: 60_000 }, // 每分钟 100 个，控制 provider 速率
  }
);
```

## 实战 checklist

我自己每个新项目上线前过的优化清单：

1. **prompt cache 必开**：长 system prompt 标 `cache_control`
2. **加 ExactCache**：FAQ / 模板生成场景，命中率高
3. **如果有"问法差异大、意图相同"的高频 case**：上 SemanticCache + 双阶段校验
4. **加模型路由**：简单 query → Haiku/4o-mini，省 60%+ 没难度
5. **挂 BudgetGuard**：硬限额 + 告警
6. **LangSmith 看 dashboard**：周末看一眼，找 top 10 最贵 trace 重点优化
7. **历史超过 20 轮的对话自动压缩**：用 middleware 透明做
8. **非实时任务走 batch API**：50% 直接打掉

做完这一套，我自己的项目从 ¥18k 砍到 ¥6k，质量基本无损（核心 evaluator 分数没退化）。

## 小结

LLM 成本优化是多层组合拳：精确缓存命中重复请求，语义缓存覆盖相似请求，prompt cache 复用稳定前缀，模型路由按难度分流。监控用 callback handler 收集每次调用的 token 用量，BudgetGuard 做硬限额保护。非实时任务走 batch API 直接打 5 折。优化的核心是先看清成本花在哪——LangSmith dashboard + Prometheus 是基础，没数据就没法做决策。

下一节 [安全防御](./04-security.md) 讲 prompt injection、PII 脱敏、tool 权限沙箱这些生产 Agent 绕不开的安全话题。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
