---
title: 部署架构
feishu_url: ""
last_synced: ""
---

> 模块 08 - 生产部署 | 前置知识：[API 服务化](./api-server.md)、[流式接口部署](./streaming-api.md)

## 怎么选部署形态

我在不同项目里部署过单体 Docker、K8s 多副本、Cloudflare Workers、AWS Lambda、阿里云函数计算。选错一次就要付出迁移成本，先把判断维度讲清楚。

| 形态 | 适合场景 | 不适合场景 |
|------|----------|-------------|
| 单体 Docker | 小流量（< 50 QPS）、初创、内部工具 | 弹性突增、SLA 99.9%+ |
| K8s 多副本 | 大流量、稳定 QPS、需自定义 GPU 推理 | 团队没人维护 K8s |
| Cloudflare Workers | 全球延迟敏感、边缘计算、轻 Agent | 长流式（> 30s）、本地状态 |
| Vercel Edge / AWS Lambda | 突发流量、Serverless 优先 | 30s/15min 执行上限、冷启动敏感 |
| 阿里云 ECS / 函数计算 | 国内合规 / ICP 备案要求 | 全球部署 |

关键判断：

1. **流量稳定吗？** 稳定 → 长驻 Docker / K8s；峰谷大 → Serverless
2. **执行时间多长？** 长 Agent（multi-step + 工具调用 > 30s）→ 长驻；短调用 → Serverless OK
3. **有 Postgres / Redis 这种有状态依赖吗？** 有 → 选近地区机房；纯无状态 → 边缘部署
4. **合规要求？** 国内 ToC 用户 → 阿里云 / 腾讯云 + ICP；ToB 海外 → AWS / Cloudflare

下面按"单体 → K8s → Serverless"递进展开。

## 单体部署：Docker 一把梭

90% 的 Agent 应用从这里开始。一个 Dockerfile + docker-compose 就能跑生产。

### Dockerfile（多阶段构建）

```dockerfile
# Dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --production

FROM node:22-slim AS runtime
WORKDIR /app

# 非 root 用户
RUN groupadd -r app && useradd -r -g app app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

`.dockerignore`：

```
node_modules
dist
.env
.env.*
.git
.github
*.md
tests/
coverage/
.claude/
research/
review/
```

### docker-compose（含 Redis + Postgres）

```yaml
# docker-compose.yml
version: "3.9"

services:
  agent:
    build: .
    ports: ["3000:3000"]
    environment:
      - NODE_ENV=production
      - PORT=3000
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - LANGCHAIN_TRACING_V2=true
      - LANGCHAIN_API_KEY=${LANGCHAIN_API_KEY}
      - LANGCHAIN_PROJECT=agent-prod
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/agent
      - API_KEYS=${API_KEYS}
    depends_on:
      redis: { condition: service_healthy }
      postgres: { condition: service_healthy }
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 1G, cpus: "1.0" }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health/live').then(r=>r.ok?process.exit(0):process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    volumes: [redis_data:/data]
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      retries: 5

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: agent
    volumes: [pg_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      retries: 5

volumes:
  redis_data:
  pg_data:
```

启动：

```bash
docker-compose up -d
docker-compose logs -f agent
```

适合单机 50 QPS 以内、内部工具、初创 MVP。前面挂个 Nginx 做 TLS + SSE 反代（参考 [流式接口部署](./streaming-api.md)）就能上线。

## 多副本 K8s 部署

QPS 上百 / 需要 99.9% SLA 后，单体不够。上 K8s 之前先把状态拆出去——这是水平扩展的前提。

### 状态外置

LangGraph 1.x 的 checkpointer 决定了对话历史存哪。开发期用 `MemorySaver`（内存），生产必须用 Postgres 或 Redis：

```typescript
// src/lib/checkpointer.ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { createAgent } from "langchain";

// Postgres 持久化（推荐）：跨进程共享，长期保存
const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
await checkpointer.setup(); // 首次创建表

// 或 Redis（更轻，适合短期会话）
// const checkpointer = new RedisSaver({ url: process.env.REDIS_URL });

export const agent = createAgent({
  model,
  tools,
  systemPrompt: "...",
  checkpointer,
});
```

接入后，任意 pod 拿到 `thread_id` 都能从 checkpointer 读出历史继续——sticky session 不再需要，HPA 可以激进扩缩。

### Deployment + Service + HPA

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: langchain-agent
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels: { app: langchain-agent }
  template:
    metadata:
      labels: { app: langchain-agent }
    spec:
      containers:
        - name: agent
          image: ghcr.io/diguike/langchain-agent:1.0.0
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef: { name: agent-secrets }
          resources:
            requests: { memory: 512Mi, cpu: 250m }
            limits: { memory: 1Gi, cpu: 1000m }
          livenessProbe:
            httpGet: { path: /health/live, port: 3000 }
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
            initialDelaySeconds: 15
            periodSeconds: 10
          lifecycle:
            preStop:
              # 优雅退出：先等 in-flight 请求完成
              exec: { command: ["sh", "-c", "sleep 15"] }
---
apiVersion: v1
kind: Service
metadata:
  name: langchain-agent-svc
spec:
  selector: { app: langchain-agent }
  ports: [{ port: 80, targetPort: 3000 }]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: langchain-agent-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: langchain-agent
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
    - type: Resource
      resource:
        name: memory
        target: { type: Utilization, averageUtilization: 80 }
```

几个 LLM 应用特有的注意点：

- **CPU/Memory 不是 LLM 的瓶颈**：LLM 应用大部分时间是 I/O 等待（等模型回包）。HPA 按 CPU 扩可能扩不动。更准的指标是**并发连接数**或**P95 延迟**，用 KEDA + 自定义 metric 接入 Prometheus
- **副本数下限别太小**：rolling update 时副本要够多防止瞬时容量不足
- **preStop sleep**：pod 收 SIGTERM 后等几秒让 readiness probe 失败传播到 Service，再实际终止进程

### 入口 Ingress（含 SSE 配置）

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: langchain-agent-ingress
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "1m"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.example.com]
      secretName: api-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: langchain-agent-svc, port: { number: 80 } }
```

`proxy-buffering: off` 是 SSE 的命门，[流式接口部署](./streaming-api.md) 里讲过。

## Serverless 部署

### Cloudflare Workers（边缘，最适合轻 Agent）

Hono 原生支持 Cloudflare Workers：

```typescript
// src/worker.ts
import { Hono } from "hono";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

type Env = {
  ANTHROPIC_API_KEY: string;
  LANGCHAIN_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

app.post("/api/v1/chat/stream", async (c) => {
  const body = await c.req.json();

  // 在请求级别构造 agent（Workers 不允许在模块级别访问 env）
  const agent = createAgent({
    model: new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: c.env.ANTHROPIC_API_KEY,
    }),
    tools: [/* ... */],
    systemPrompt: "...",
  });

  const stream = await agent.stream(
    { messages: [{ role: "user", content: body.message }] },
    { streamMode: "messages", encoding: "text/event-stream" }
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});

export default app;
```

`wrangler.toml`：

```toml
name = "langchain-agent"
main = "src/worker.ts"
compatibility_date = "2026-05-25"
compatibility_flags = ["nodejs_compat"]

[vars]
LANGCHAIN_PROJECT = "agent-prod"

# 状态：用 Cloudflare D1 / KV / Durable Objects
[[kv_namespaces]]
binding = "CACHE"
id = "xxx"
```

部署：

```bash
npx wrangler deploy
```

Workers 的限制：

- **CPU time 30 秒上限**（付费版可以放宽到 5 分钟）：长 Agent 跑不完
- **没有持久连接到 Postgres**：用 Hyperdrive 或 D1 替代
- **冷启动近乎无**：但 cold edge 跨大洲首请求可能慢 100-300ms

适合：短链路 Agent（< 10 秒）、需要全球低延迟、状态用 D1/KV 的场景。

### Vercel Edge Functions

Next.js App Router + Edge Runtime：

```typescript
// app/api/chat/stream/route.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

export const runtime = "edge";

export async function POST(req: Request) {
  const { message } = await req.json();

  const agent = createAgent({
    model: new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
    }),
    tools: [/* ... */],
    systemPrompt: "...",
  });

  const stream = await agent.stream(
    { messages: [{ role: "user", content: message }] },
    { streamMode: "messages", encoding: "text/event-stream" }
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
```

限制：

- Edge Runtime 最大 30 秒
- Node Runtime 最大 10 秒（Hobby）/ 60 秒（Pro）/ 900 秒（Enterprise）
- 同样不能跑长 Agent

### AWS Lambda

```typescript
// handler.ts
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = JSON.parse(event.body ?? "{}");
  const result = await agent.invoke({
    messages: [{ role: "user", content: body.message }],
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, message: result.messages.at(-1)?.content }),
  };
};
```

Lambda 上 SSE 流式需要 Lambda Function URLs 或 API Gateway WebSocket（流式比较麻烦）。冷启动 2-3 秒是常态，用 Provisioned Concurrency 可降到几百毫秒但要钱。

### Serverless 通用建议

- **不要在模块级别打开数据库连接**：每次冷启动重新连
- **API Key 用 secret manager**（AWS Secrets Manager / Vercel Env / CF Secrets），不要写代码里
- **超时配置要小心**：函数超时 > Agent 最长执行时间 > 客户端超时
- **长 Agent 用队列**：见下面"异步队列"

## 长会话 / 长任务：异步队列

执行超过 30 秒的 Agent 任务，不管什么部署形态都建议异步化。前端提交任务拿到 jobId，长轮询或 WebSocket 查结果。

```typescript
// src/queue/agent-worker.ts
import { Queue, Worker } from "bullmq";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

const connection = {
  host: process.env.REDIS_HOST!,
  port: parseInt(process.env.REDIS_PORT ?? "6379"),
};

export const agentQueue = new Queue("agent-tasks", { connection });

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-opus-4-7" }), // 长任务用最强
  tools: [/* ... */],
  systemPrompt: "...",
});

new Worker(
  "agent-tasks",
  async (job) => {
    const { message, userId } = job.data;
    await job.updateProgress(10);

    const result = await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      { runName: `Async-${userId}` }
    );

    await job.updateProgress(100);
    return {
      answer: result.messages.at(-1)?.content,
      steps: result.messages.length,
    };
  },
  {
    connection,
    concurrency: 5,
    limiter: { max: 30, duration: 60_000 }, // 控制 LLM provider 速率
  }
);
```

API route 只负责入队：

```typescript
// src/routes/async-chat.ts
const asyncChat = new Hono();

asyncChat.post("/chat/async", async (c) => {
  const body = await c.req.json();
  const job = await agentQueue.add(
    "process",
    { message: body.message, userId: c.get("userId") },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    }
  );
  return c.json({ ok: true, jobId: job.id });
});

asyncChat.get("/chat/async/:jobId", async (c) => {
  const job = await agentQueue.getJob(c.req.param("jobId"));
  if (!job) return c.json({ ok: false, error: "Not found" }, 404);

  const state = await job.getState();
  return c.json({
    ok: true,
    state,
    progress: job.progress,
    result: state === "completed" ? job.returnvalue : undefined,
    error: state === "failed" ? job.failedReason : undefined,
  });
});
```

## CI/CD：自动化部署

```yaml
# .github/workflows/deploy.yml
name: Build & Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test
      - run: npm run lint

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions: { packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "${{ secrets.KUBECONFIG }}" > /tmp/kubeconfig
          export KUBECONFIG=/tmp/kubeconfig
          kubectl set image deployment/langchain-agent \
            agent=ghcr.io/${{ github.repository }}:${{ github.sha }}
          kubectl rollout status deployment/langchain-agent --timeout=300s
```

加一步**部署前跑核心 evaluator**（[评估方法与指标](../07-observability/evaluation.md)），分数跌过阈值直接红灯，避免坏 prompt / 坏 prompt cache 上线。

## 监控告警：三套并用

生产 LLM 应用我会同时跑三套监控：

1. **LangSmith**：业务级 trace + dataset eval，定位"为什么这条回答错了"
2. **Prometheus + Grafana**：SRE 级指标，QPS / 延迟 / 错误率 / token 用量
3. **Sentry**：异常监控 + 错误堆栈，定位代码 bug

### Prometheus 指标

[Callback 系统](../07-observability/callbacks.md) 里讲过 `PromHandler` 的实现。Hono route：

```typescript
// src/routes/metrics.ts
import { Hono } from "hono";
import { register } from "prom-client";

const metrics = new Hono();

metrics.get("/metrics", async (c) => {
  c.header("Content-Type", register.contentType);
  return c.text(await register.metrics());
});

export default metrics;
```

Prometheus 配置：

```yaml
scrape_configs:
  - job_name: langchain-agent
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: langchain-agent
        action: keep
    metrics_path: /metrics
```

### 告警规则

```yaml
groups:
  - name: langchain-agent
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(llm_requests_total{status="error"}[5m]))
            / sum(rate(llm_requests_total[5m])) > 0.05
        for: 3m
        labels: { severity: critical }
        annotations:
          summary: "LLM 错误率超过 5%"

      - alert: HighP95Latency
        expr: |
          histogram_quantile(0.95, rate(llm_request_duration_seconds_bucket[5m])) > 15
        for: 5m
        annotations:
          summary: "LLM P95 延迟超过 15 秒"

      - alert: HourlyTokenSpike
        expr: |
          increase(llm_tokens_total[1h]) > 5000000
        annotations:
          summary: "单小时 token 用量异常（> 500 万）"

      - alert: BudgetExceeded
        expr: sum(llm_cost_usd_total) > 1000
        annotations:
          summary: "当日成本超过 $1000"
```

告警发到 Slack / 飞书 / PagerDuty。

### Sentry 集成

```typescript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});

// 捕获未处理异常
app.onError((err, c) => {
  Sentry.captureException(err);
  return c.json({ ok: false, error: "Internal error" }, 500);
});
```

## 灾备 / 故障域设计

LLM provider 自己就经常挂——OpenAI、Anthropic 都有过整天的不可用。生产系统要做到 fallback：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

const primaryAgent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

const fallbackAgent = createAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [/* ... */],
  systemPrompt: "...",
});

async function robustInvoke(input: any) {
  try {
    return await primaryAgent.invoke(input);
  } catch (e: any) {
    if (/503|529|rate_limit|connection/i.test(e.message)) {
      console.warn("[fallback] primary failed, switching to backup");
      return await fallbackAgent.invoke(input);
    }
    throw e;
  }
}
```

更稳的做法是**用 LangChain 内置的 `.withFallbacks([...])`**：

```typescript
const model = new ChatAnthropic({ model: "claude-sonnet-4-6" })
  .withFallbacks([new ChatOpenAI({ model: "gpt-4o" })]);

const agent = createAgent({ model, tools, systemPrompt: "..." });
```

主模型抛错自动切 fallback，对 Agent 透明。注意 fallback 模型最好能用相似的 tool calling 协议（OpenAI 和 Anthropic 行为接近，Google Gemini 差异大）。

## 实战部署 checklist

我的项目上线前过的：

- [ ] **状态外置**：checkpointer 用 Postgres / Redis，不用 MemorySaver
- [ ] **健康检查**：liveness / readiness 都暴露，readiness 检查依赖（DB、Redis、可达 LLM provider）
- [ ] **优雅退出**：SIGTERM 后等 in-flight 完成，preStop 加 sleep
- [ ] **资源限制**：memory / cpu limit 都设，防内存泄漏拖垮节点
- [ ] **滚动更新**：maxUnavailable: 0 避免容量空窗
- [ ] **SSE 反代**：proxy_buffering off，超时大
- [ ] **监控三件套**：LangSmith + Prometheus + Sentry 全接
- [ ] **告警**：错误率 / 延迟 / token 用量 / 成本，分级别发不同渠道
- [ ] **Provider fallback**：`.withFallbacks` 配主备模型
- [ ] **Secret 不在镜像里**：用 K8s Secret / Vault / Secrets Manager
- [ ] **CI 跑 evaluator**：核心回归集过了再发版

## 小结

部署形态选择看流量稳定性、执行时长、合规、运维能力。小流量先单体 Docker 跑通；流量上来上 K8s 多副本配 Postgres checkpointer + HPA；轻量低延迟场景上 Cloudflare Workers / Vercel Edge；长任务异步化用 BullMQ。监控用 LangSmith 看业务、Prometheus 看 SRE 指标、Sentry 看错误。LLM provider 容灾用 `.withFallbacks` 配主备。

模块 08 到这里结束。把前 8 个模块串起来——从 Runnable 抽象、Tool 定义、Agent 架构、RAG、可观测、到生产部署——一个完整的 LangChain.js Agent 项目就能落地。后续阅读建议看附录的 [API Cheatsheet](../appendix/api-cheatsheet.md) 做日常查阅。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
