---
title: 自定义后端 - 实现自己的 checkpointer 与 store
feishu_url: ""
last_synced: ""
---

> 模块 03 - 记忆系统 | 第 5 节 | 前置：[VectorStore 记忆作为工具](./vectorstore-memory.md)

## 为什么要自己写后端

1.x 官方提供了 `MemorySaver` / `SqliteSaver` / `PostgresSaver` 三个 checkpointer 和 `InMemoryStore` / `PostgresStore` 两个 store。覆盖了 80% 的场景。但还有几种情况你得自己动手：

- **Redis 极低延迟场景**：聊天 IM、语音助手，延迟要求 <10ms，Postgres 不够快
- **公司已有的存储基础设施**：DynamoDB、TiDB、MongoDB，老板希望复用，不想再添新组件
- **特殊业务约束**：审计、合规、加密、PII 脱敏需要在存储层做，官方实现不能改
- **多区域复制**：跨地域部署，需要自己控制复制策略

老 LangChain.js 这一层叫 `BaseListChatMessageHistory`（消息历史接口）。1.x 概念变了：

| 老 API | 1.x 对应 |
|--------|---------|
| `BaseListChatMessageHistory` | `BaseCheckpointSaver`（线程级）+ `BaseStore`（跨会话）|
| `RedisChatMessageHistory` | 自己实现 `BaseCheckpointSaver` |

接口数量变多了一点，但获得了 thread / store 分层带来的好处。下面分别讲。

## `BaseCheckpointSaver` 接口

LangGraph 把"按 thread_id 持久化状态"抽象成了 `BaseCheckpointSaver`，源码在 `@langchain/langgraph-checkpoint`。要自定义 checkpointer，实现四个方法：

```typescript
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

abstract class BaseCheckpointSaver {
  // 读：取某个 thread 的最新或指定 checkpoint
  abstract getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>;

  // 列表：流式遍历某个 thread 的 checkpoint 历史
  abstract list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig }
  ): AsyncGenerator<CheckpointTuple>;

  // 写：保存一个 checkpoint
  abstract put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, string | number>
  ): Promise<RunnableConfig>;

  // 中间写：保存执行中的 pending writes（用于失败重试）
  abstract putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void>;
}
```

`config.configurable` 里读三个字段：`thread_id`、`checkpoint_ns`（命名空间，默认空字符串）、`checkpoint_id`（指定某个具体 checkpoint，不传就拿最新）。

> 完整 TypeScript 定义见 [langgraph-checkpoint 源码](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint)。下面的 Redis 实现是经过简化的最小可工作版本，生产代码请把序列化、错误处理、连接池都补齐。

---

## 实现一个 Redis Checkpointer

完整代码以 [ioredis](https://github.com/redis/ioredis) 为例。先装包：

```bash
npm install @langchain/langgraph-checkpoint ioredis
```

核心实现：

```typescript
// redis-checkpointer.ts
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import Redis from "ioredis";

export class RedisCheckpointer extends BaseCheckpointSaver {
  private client: Redis;
  private prefix: string;
  private ttlSeconds?: number;

  constructor(opts: {
    url?: string;
    prefix?: string;
    ttlSeconds?: number;
    serde?: SerializerProtocol;
  }) {
    super(opts.serde);
    this.client = new Redis(opts.url ?? "redis://localhost:6379");
    this.prefix = opts.prefix ?? "lg:cp:";
    this.ttlSeconds = opts.ttlSeconds;
  }

  // Redis key 设计：
  //   {prefix}thread:{tid}:ns:{ns}:cp:{cid}        -> checkpoint blob
  //   {prefix}thread:{tid}:ns:{ns}:latest          -> 最新 checkpoint_id
  //   {prefix}thread:{tid}:ns:{ns}:list            -> sorted set，score=ts
  //   {prefix}thread:{tid}:ns:{ns}:writes:{cid}    -> hash，taskId -> writes
  private keyCp(tid: string, ns: string, cid: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:cp:${cid}`;
  }
  private keyLatest(tid: string, ns: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:latest`;
  }
  private keyList(tid: string, ns: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:list`;
  }
  private keyWrites(tid: string, ns: string, cid: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:writes:${cid}`;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    let cid = config.configurable?.checkpoint_id as string | undefined;

    if (!cid) {
      cid = (await this.client.get(this.keyLatest(tid, ns))) ?? undefined;
      if (!cid) return undefined;
    }

    const raw = await this.client.getBuffer(this.keyCp(tid, ns, cid));
    if (!raw) return undefined;

    // serde 接口随 @langchain/langgraph-checkpoint 版本演进，
    // 这里基于 1.x 的签名；实际使用前请对照源码确认
    const { checkpoint, metadata } = await this.serde.loadsTyped("json", raw);

    // 取出 pending writes
    const writesHash = await this.client.hgetallBuffer(this.keyWrites(tid, ns, cid));
    const pendingWrites: [string, string, unknown][] = [];
    for (const [field, value] of Object.entries(writesHash)) {
      const [taskId, idx] = field.split(":");
      const [channel, val] = await this.serde.loadsTyped("json", value as Buffer);
      pendingWrites.push([taskId, channel, val]);
    }

    return {
      config: { configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid } },
      checkpoint,
      metadata,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig }
  ): AsyncGenerator<CheckpointTuple> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const limit = options?.limit ?? -1;

    // 倒序取最近 N 个 checkpoint_id
    const ids = await this.client.zrevrange(this.keyList(tid, ns), 0, limit - 1);
    for (const cid of ids) {
      const tuple = await this.getTuple({
        configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid },
      });
      if (tuple) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, string | number>
  ): Promise<RunnableConfig> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const cid = checkpoint.id;

    const [, payload] = this.serde.dumpsTyped({ checkpoint, metadata });

    const pipeline = this.client.pipeline();
    pipeline.set(this.keyCp(tid, ns, cid), payload);
    pipeline.set(this.keyLatest(tid, ns), cid);
    pipeline.zadd(this.keyList(tid, ns), Date.now(), cid);

    if (this.ttlSeconds) {
      pipeline.expire(this.keyCp(tid, ns, cid), this.ttlSeconds);
      pipeline.expire(this.keyLatest(tid, ns), this.ttlSeconds);
      pipeline.expire(this.keyList(tid, ns), this.ttlSeconds);
    }

    await pipeline.exec();
    return {
      configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const cid = config.configurable?.checkpoint_id as string;

    const pipeline = this.client.pipeline();
    writes.forEach(([channel, value], idx) => {
      const [, payload] = this.serde.dumpsTyped([channel, value]);
      pipeline.hset(this.keyWrites(tid, ns, cid), `${taskId}:${idx}`, payload);
    });
    if (this.ttlSeconds) {
      pipeline.expire(this.keyWrites(tid, ns, cid), this.ttlSeconds);
    }
    await pipeline.exec();
  }
}
```

### 用法

```typescript
import { createAgent } from "langchain";
import { RedisCheckpointer } from "./redis-checkpointer";

const checkpointer = new RedisCheckpointer({
  url: process.env.REDIS_URL,
  prefix: "myapp:cp:",
  ttlSeconds: 7 * 24 * 3600, // 7 天过期
});

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  checkpointer,
});

const config = { configurable: { thread_id: "redis-demo" } };
await agent.invoke({ messages: [{ role: "user", content: "我叫张三" }] }, config);
// 几小时后，进程重启
await agent.invoke({ messages: [{ role: "user", content: "我叫什么？" }] }, config);
// → "你叫张三"，从 Redis 加载历史
```

### 关键设计点

- **序列化**：`this.serde.dumpsTyped` 处理 BaseMessage、自定义对象、Date 等结构。**别用 `JSON.stringify` 自己来**，会丢类型信息
- **`latest` 索引**：单独 key 存最新 checkpoint_id，避免每次 `getTuple` 都扫 list
- **TTL**：通过 `expire` 让 Redis 自己清理。给老旧 checkpoint 设短 TTL，新的设长，可以做"近期完整 + 远期淘汰"
- **pendingWrites**：用于失败重试。LangGraph 在执行中如果中断，恢复时会先 replay 这些 writes。生产实现必须正确处理，否则中断恢复行为会不对

---

## `BaseStore` 接口：跨会话的长期记忆

`store` 跟 `checkpointer` 处理不同的问题。`checkpointer` 是 thread 内的、按时间序列演进的状态；`store` 是跨 thread 的、按命名空间和 key 组织的 KV。两者通常同时配置，互不冲突。

`BaseStore` 主要四个方法：

```typescript
import { BaseStore } from "@langchain/langgraph";

abstract class BaseStore {
  // 读单条
  abstract get(namespace: string[], key: string): Promise<Item | null>;

  // 写
  abstract put(namespace: string[], key: string, value: Record<string, any>): Promise<void>;

  // 删
  abstract delete(namespace: string[], key: string): Promise<void>;

  // 按 namespace 列表（支持前缀匹配 / 过滤 / 分页）
  abstract search(
    namespacePrefix: string[],
    options?: { filter?: Record<string, any>; limit?: number; offset?: number }
  ): Promise<Item[]>;
}
```

`namespace` 是一个字符串数组，通常用来做分层隔离，例如 `[userId, "profile"]` / `[orgId, userId, "facts"]`。多租户场景下这是隔离的主要手段，下一节会详讲。

### 一个最简 Redis Store

```typescript
// redis-store.ts
import { BaseStore, type Item } from "@langchain/langgraph";
import Redis from "ioredis";

export class RedisStore extends BaseStore {
  private client: Redis;
  private prefix: string;

  constructor(opts: { url?: string; prefix?: string }) {
    super();
    this.client = new Redis(opts.url ?? "redis://localhost:6379");
    this.prefix = opts.prefix ?? "lg:store:";
  }

  private nsKey(ns: string[]) {
    return `${this.prefix}${ns.join(":")}`;
  }

  async get(ns: string[], key: string): Promise<Item | null> {
    const raw = await this.client.hget(this.nsKey(ns), key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return {
      namespace: ns,
      key,
      value,
      createdAt: new Date(value.__createdAt ?? Date.now()),
      updatedAt: new Date(value.__updatedAt ?? Date.now()),
    };
  }

  async put(ns: string[], key: string, value: Record<string, any>) {
    const now = Date.now();
    const enriched = { ...value, __createdAt: value.__createdAt ?? now, __updatedAt: now };
    await this.client.hset(this.nsKey(ns), key, JSON.stringify(enriched));
  }

  async delete(ns: string[], key: string) {
    await this.client.hdel(this.nsKey(ns), key);
  }

  async search(
    nsPrefix: string[],
    options?: { filter?: Record<string, any>; limit?: number; offset?: number }
  ): Promise<Item[]> {
    const pattern = `${this.prefix}${nsPrefix.join(":")}*`;
    const items: Item[] = [];

    // SCAN 比 KEYS 安全，生产必须用 SCAN
    const stream = this.client.scanStream({ match: pattern, count: 100 });
    for await (const keys of stream) {
      for (const k of keys as string[]) {
        const ns = k.replace(this.prefix, "").split(":");
        const fields = await this.client.hgetall(k);
        for (const [field, val] of Object.entries(fields)) {
          const value = JSON.parse(val);
          // 简单 filter 过滤
          if (
            options?.filter &&
            !Object.entries(options.filter).every(([k, v]) => value[k] === v)
          ) {
            continue;
          }
          items.push({
            namespace: ns,
            key: field,
            value,
            createdAt: new Date(value.__createdAt),
            updatedAt: new Date(value.__updatedAt),
          });
        }
      }
    }

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? items.length;
    return items.slice(offset, offset + limit);
  }
}
```

### 用法

```typescript
import { createAgent } from "langchain";
import { RedisCheckpointer } from "./redis-checkpointer";
import { RedisStore } from "./redis-store";

const checkpointer = new RedisCheckpointer({ prefix: "myapp:cp:" });
const store = new RedisStore({ prefix: "myapp:store:" });

const agent = createAgent({
  model: "anthropic:claude-sonnet-4-6",
  tools: [],
  checkpointer,
  store,
});

// 在某个工具或 middleware 里：
await store.put(["user-001", "profile"], "tech_stack", { langs: ["Go", "Python"] });
const item = await store.get(["user-001", "profile"], "tech_stack");
console.log(item?.value);

// 检索某 namespace 下所有条目
const facts = await store.search(["user-001", "facts"]);
```

注意 `BaseStore` 的搜索是基于 namespace 前缀，**不是**向量语义搜索。如果你要在 store 里做语义检索，自己实现一个带 embedding 列的版本——官方的 `InMemoryStore` 就支持配置 `index` 参数做向量检索，可以参考它的实现思路。

## 调优要点

无论自定义 checkpointer 还是 store，几个共同的工程经验：

### 用 SCAN 不用 KEYS

Redis 的 `KEYS pattern*` 会阻塞主线程。生产代码任何要"列举"的地方都改用 `SCAN`（上面的 `scanStream`）。这点很多人写小工具时偷懒，上生产就出事。

### 显式 await setup

PostgresSaver 风格的实现里会有 `setup()` 方法负责建表。自定义 checkpointer 如果有 schema，要么在构造函数里 lazy 检测，要么暴露 `setup()` 让用户启动时调一次。**不要每次 `put` 都 CREATE TABLE IF NOT EXISTS**——会被 DBA 骂死。

### 序列化用官方的 serde

`BaseCheckpointSaver` 构造函数接收一个 `SerializerProtocol`，默认实现处理了 BaseMessage、Date、Map、Set 等结构。**别用 `JSON.stringify`**，否则 BaseMessage 反序列化回来就丢了类型，模型调用直接报错。

### 留好 metadata 字段

checkpointer 的 `put` 第三个参数是 `CheckpointMetadata`，可以塞自定义信息（步骤名、节点名、source 等）。后续做 trace、调试、监控全靠这里。生产实现一定要把它存下来，不要丢。

### TTL 和软删

按 thread_id 删除时，老的 checkpoint 实例和 pending writes 都要清理。建议在 `delete` 操作里用 Redis pipeline 一次性删完，或者打"软删标记"由定期 job 真正清理——尤其在 GDPR 等合规场景下，软删 + 审计日志更稳。

## 选型建议

什么时候应该自己写后端，什么时候用官方的？

| 场景 | 推荐 |
|------|------|
| 单元测试、demo | `MemorySaver` + `InMemoryStore` |
| 单机部署、Electron 应用 | `SqliteSaver` |
| 通用生产环境，已有/愿意上 Postgres | `PostgresSaver` + `PostgresStore` |
| 延迟 <10ms，已有 Redis | **自己实现 RedisCheckpointer + RedisStore** |
| 已有 DynamoDB / TiDB / MongoDB | 自己实现，按上面的模板照搬接口 |
| 合规/审计/PII 脱敏要求高 | 在自定义实现里加加密层 |

我的常见组合：

- **客服 / IM 类**：Redis checkpointer（聊天延迟敏感）+ Postgres store（长期画像要做分析）
- **企业内部 Agent**：Postgres checkpointer + Postgres store（运维成本最低）
- **单机 CLI 工具**：SqliteSaver，不用 store

## 小结

LangChain.js 1.x 的后端抽象是 `BaseCheckpointSaver`（thread 内状态）和 `BaseStore`（跨 thread KV）。两个接口加起来七八个方法，认真实现一遍 Redis 版本大约 200 行。

下一节 [多用户记忆隔离](./multi-user-isolation.md) 把这一切串起来——用 `thread_id` 在 checkpointer 里隔离会话，用 `namespace` 在 store 里隔离用户和租户。

参考文档：[LangGraph Persistence](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)、[Custom Checkpointer 实现示例](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint)。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
