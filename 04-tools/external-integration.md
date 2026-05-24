---
title: 外部系统集成模式
feishu_url: ""
last_synced: ""
---

> 模块 04 - 工具与函数调用 | 前置：[Tool 接口与定义](./tool-interface.md)、[自定义 Tool 开发](./custom-tool.md)、[Function Calling 跨模型统一](./function-calling.md)、[MCP Server 集成](./mcp-server.md) | 后续：[05-Agent 架构](../05-agent-architecture/create-agent.md)

## 这一节讲什么

前面四节我从 Tool 接口讲到 MCP 集成，重点都在"怎么定义工具"。这一节换个角度——一个生产 Agent 跟外部系统对接，除了"调通"之外还要考虑什么。

我整理了五个核心模式：

1. **REST 工厂**：批量包装 RESTful API
2. **认证模式**：API key、Bearer Token、OAuth 2.0、签名
3. **限流与配额**：令牌桶、滑动窗口、按用户配额
4. **降级与超时**：熔断器、超时金字塔、fallback 链
5. **安全护栏**：路径沙箱、SQL 白名单、代码沙箱

这一节代码可以全部组合到一个真实的 Agent 上。

## 1. REST (Representational State Transfer) 工厂模式

REST 是最常见的集成对象。上一节我写了一个基础版的 `createRestTool`，这里扩展成生产级——支持认证、限流、超时、重试、降级：

```typescript
// rest-tool-factory.ts
import { tool } from "@langchain/core/tools";
import { z, ZodObject, ZodRawShape } from "zod";

type AuthStrategy =
  | { type: "none" }
  | { type: "apiKey"; header: string; key: string }
  | { type: "bearer"; token: string | (() => Promise<string>) }
  | { type: "basic"; username: string; password: string };

interface RestToolConfig<T extends ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<T>;
  baseURL: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

  auth?: AuthStrategy;
  headers?: Record<string, string>;

  buildBody?: (input: z.infer<ZodObject<T>>) => unknown;
  buildPath?: (input: z.infer<ZodObject<T>>) => string;
  buildQuery?: (input: z.infer<ZodObject<T>>) => Record<string, string>;

  timeout?: number;
  maxRetries?: number;
  retryOn?: number[];

  // 把 API 响应转成 Tool 输出
  transformResponse?: (data: any) => unknown;
  // 降级：当 API 失败时返回什么
  fallback?: (input: z.infer<ZodObject<T>>) => string;
}

async function resolveAuthHeader(auth: AuthStrategy): Promise<Record<string, string>> {
  switch (auth.type) {
    case "none":
      return {};
    case "apiKey":
      return { [auth.header]: auth.key };
    case "bearer": {
      const token = typeof auth.token === "function" ? await auth.token() : auth.token;
      return { Authorization: `Bearer ${token}` };
    }
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

export function createRestTool<T extends ZodRawShape>(config: RestToolConfig<T>) {
  return tool(
    async (input) => {
      const path = config.buildPath ? config.buildPath(input) : config.endpoint;
      const query = config.buildQuery
        ? "?" + new URLSearchParams(config.buildQuery(input)).toString()
        : "";
      const url = `${config.baseURL}${path}${query}`;

      const authHeaders = config.auth ? await resolveAuthHeader(config.auth) : {};
      const fetchOptions: RequestInit = {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
          ...authHeaders,
        },
        signal: AbortSignal.timeout(config.timeout ?? 10000),
      };

      if (config.method !== "GET" && config.buildBody) {
        fetchOptions.body = JSON.stringify(config.buildBody(input));
      }

      const maxRetries = config.maxRetries ?? 2;
      const retryOn = config.retryOn ?? [429, 500, 502, 503, 504];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, fetchOptions);

          if (retryOn.includes(response.status) && attempt < maxRetries) {
            // Retry-After 头优先；没有就指数退避
            const retryAfter = response.headers.get("Retry-After");
            const backoff = retryAfter
              ? parseInt(retryAfter) * 1000
              : Math.min(1000 * 2 ** attempt, 8000);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }

          const data = await response.json().catch(() => null);

          if (!response.ok) {
            return JSON.stringify({
              success: false,
              status: response.status,
              error: data,
            });
          }

          const result = config.transformResponse ? config.transformResponse(data) : data;
          return JSON.stringify({ success: true, data: result });
        } catch (error) {
          if (attempt >= maxRetries) {
            if (config.fallback) {
              return config.fallback(input);
            }
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "请求失败",
            });
          }
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
        }
      }

      return JSON.stringify({ success: false, error: "重试已用尽" });
    },
    {
      name: config.name,
      description: config.description,
      schema: config.schema,
    }
  );
}
```

实际用法——一个完整的 GitHub 搜索工具：

```typescript
const searchGitHub = createRestTool({
  name: "search_github_repos",
  description: "在 GitHub 搜索代码仓库，按 stars 或更新时间排序",
  schema: z.object({
    query: z.string().describe("搜索关键词"),
    language: z.string().optional().describe("编程语言"),
    sort: z.enum(["stars", "updated", "forks"]).default("stars"),
  }),
  baseURL: "https://api.github.com",
  endpoint: "/search/repositories",
  method: "GET",
  auth: { type: "bearer", token: process.env.GITHUB_TOKEN! },
  buildQuery: ({ query, language, sort }) => ({
    q: language ? `${query} language:${language}` : query,
    sort,
    per_page: "5",
  }),
  transformResponse: (data) => ({
    total: data.total_count,
    repos: data.items.map((r: any) => ({
      name: r.full_name,
      stars: r.stargazers_count,
      url: r.html_url,
      language: r.language,
    })),
  }),
  timeout: 8000,
  maxRetries: 2,
});
```

## 2. 认证模式

API key 和 Bearer Token 是最常见的两种，上面的工厂直接支持。OAuth 2.0 稍复杂一点，但本质就是 token 刷新——用工厂的 `bearer` + 函数形式拿动态 token：

```typescript
// oauth-token-provider.ts
class OAuthTokenProvider {
  private accessToken: string | null = null;
  private expiresAt: number = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokenUrl: string
  ) {}

  async getToken(): Promise<string> {
    // token 还在有效期内（提前 60 秒刷新）
    if (this.accessToken && Date.now() < this.expiresAt - 60000) {
      return this.accessToken;
    }

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth token 获取失败: ${response.status}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken!;
  }
}

// 用进工厂
const oauthProvider = new OAuthTokenProvider(
  process.env.OAUTH_CLIENT_ID!,
  process.env.OAUTH_CLIENT_SECRET!,
  "https://auth.example.com/oauth/token"
);

const protectedApi = createRestTool({
  // ...其他配置
  auth: {
    type: "bearer",
    token: () => oauthProvider.getToken(),  // 每次自动刷新
  },
});
```

签名认证（AWS SigV4、阿里云这种）更复杂，建议直接用厂商 SDK 而不是手写——但 SDK 输出的客户端依然可以被 `tool()` 封装。

## 3. 限流：令牌桶与按用户配额

外部 API 一般都有 rate limit。即便 API 本身允许 100 QPS，我也会在 Tool 层加一层节流，避免 Agent 一次性炸穿：

```typescript
// rate-limiter.ts

// 简单的滑动窗口限流器
export class SlidingWindowLimiter {
  private timestamps: Map<string, number[]> = new Map();

  constructor(
    private maxCalls: number,
    private windowMs: number
  ) {}

  /**
   * 返回 true 表示通过，false 表示被限流
   */
  check(key: string = "default"): boolean {
    const now = Date.now();
    const valid = (this.timestamps.get(key) ?? []).filter(
      (t) => now - t < this.windowMs
    );

    if (valid.length >= this.maxCalls) {
      this.timestamps.set(key, valid);
      return false;
    }

    valid.push(now);
    this.timestamps.set(key, valid);
    return true;
  }

  /**
   * 计算还要多久才能再调用一次
   */
  retryAfter(key: string = "default"): number {
    const calls = this.timestamps.get(key) ?? [];
    if (calls.length < this.maxCalls) return 0;
    const oldest = calls[0];
    return Math.max(0, this.windowMs - (Date.now() - oldest));
  }
}

// 用法：把任何 Tool 包成"带限流的 Tool"
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

export function withRateLimit<T extends StructuredToolInterface>(
  original: T,
  limiter: SlidingWindowLimiter,
  keyExtractor?: (input: any) => string
) {
  return tool(
    async (input: any) => {
      const key = keyExtractor ? keyExtractor(input) : "default";

      if (!limiter.check(key)) {
        const retryAfter = limiter.retryAfter(key);
        return JSON.stringify({
          success: false,
          error: "RATE_LIMITED",
          message: `调用频率超限，约 ${Math.ceil(retryAfter / 1000)} 秒后可重试`,
          retryAfter,
        });
      }

      return original.invoke(input);
    },
    {
      name: original.name,
      description: original.description,
      schema: original.schema as any,
    }
  );
}
```

按用户配额：传入 `keyExtractor` 从 input 里取 user_id：

```typescript
const userLimiter = new SlidingWindowLimiter(10, 60000); // 每个用户每分钟 10 次

const limitedTool = withRateLimit(
  someTool,
  userLimiter,
  (input) => input.userId  // 每个用户独立计数
);
```

## 4. 降级与超时金字塔

我喜欢把超时设成"金字塔"：内层快、外层慢，留出重试空间。

举个具体例子：

| 层 | 超时 | 原因 |
|----|------|------|
| 单次 HTTP 请求 | 3 秒 | 网络抖动 |
| 整个 Tool（含重试） | 10 秒 | 给重试预留时间（3s × 3 ≈ 10s） |
| Agent 单轮 | 30 秒 | 多工具并行 + 模型思考 |
| 整个 Agent 会话 | 5 分钟 | 极端复杂任务的兜底 |

代码上：

```typescript
const tool = createRestTool({
  // ...
  timeout: 3000,       // 单次请求 3 秒
  maxRetries: 2,       // 最多 3 次尝试，约 10 秒兜底
  fallback: ({ city }) => {
    // 主 API 完全失败时的降级回答
    return JSON.stringify({
      success: false,
      error: "服务暂时不可用",
      hint: `请稍后查询 ${city} 的天气，或尝试其他城市`,
    });
  },
});
```

更激进一点的降级：fallback 链。主 API 挂了换备用 API：

```typescript
async function fallbackChain(input: any): Promise<string> {
  const apis = [
    "https://primary.example.com",
    "https://backup1.example.com",
    "https://backup2.example.com",
  ];

  for (const baseURL of apis) {
    try {
      const response = await fetch(`${baseURL}/weather?city=${input.city}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = await response.json();
        return JSON.stringify({ success: true, source: baseURL, data });
      }
    } catch {
      continue;  // 这个挂了，试下一个
    }
  }

  return JSON.stringify({ success: false, error: "所有数据源都不可用" });
}
```

熔断器我一般会在网关层做（用 nginx、Envoy 或 Istio），不在 Tool 内部实现——因为 Tool 是无状态的，熔断器需要持久化状态。

## 5. 安全护栏

### 路径沙箱：文件系统 Tool

让 Agent 操作文件是有用但危险的能力。第一道防线是路径沙箱——把所有路径都限定在工作目录内：

```typescript
// fs-tools.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

const WORKSPACE = path.resolve("/tmp/agent-workspace");

function validatePath(userPath: string): string {
  const resolved = path.resolve(WORKSPACE, userPath);
  // 关键检查：解析后的路径必须仍在 WORKSPACE 内
  if (!resolved.startsWith(WORKSPACE + path.sep) && resolved !== WORKSPACE) {
    throw new Error(`路径越界：${userPath} 解析为 ${resolved}`);
  }
  return resolved;
}

export const readFileTool = tool(
  async ({ filePath, encoding }) => {
    try {
      const safePath = validatePath(filePath);
      const content = await fs.readFile(safePath, {
        encoding: encoding as BufferEncoding,
      });

      // 限制返回大小，防止把大文件灌进模型上下文
      if (content.length > 10000) {
        return JSON.stringify({
          success: true,
          truncated: true,
          content: content.slice(0, 10000),
          totalLength: content.length,
          hint: "文件过大，仅返回前 10000 字符",
        });
      }

      return JSON.stringify({ success: true, content, length: content.length });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "读取失败",
      });
    }
  },
  {
    name: "read_file",
    description: "读取工作目录内的文件。大文件会自动截断。",
    schema: z.object({
      filePath: z.string().describe("相对于工作目录的路径"),
      encoding: z.enum(["utf-8", "ascii", "base64"]).default("utf-8"),
    }),
  }
);

export const writeFileTool = tool(
  async ({ filePath, content, createDirs }) => {
    try {
      const safePath = validatePath(filePath);
      if (createDirs) {
        await fs.mkdir(path.dirname(safePath), { recursive: true });
      }
      await fs.writeFile(safePath, content, "utf-8");
      const stats = await fs.stat(safePath);
      return JSON.stringify({
        success: true,
        path: filePath,
        size: stats.size,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "写入失败",
      });
    }
  },
  {
    name: "write_file",
    description: "在工作目录内创建或覆写文件",
    schema: z.object({
      filePath: z.string().describe("相对于工作目录的路径"),
      content: z.string().describe("要写入的内容"),
      createDirs: z.boolean().default(true).describe("父目录不存在时是否创建"),
    }),
  }
);
```

关键是 `validatePath`——`path.resolve` 会解析 `..` 和符号链接，最后用 `startsWith` 兜底。仅靠字符串检查（比如禁用 `..`）是不够的，因为还有大小写、URL 编码、unicode 等绕过手段。

### SQL 白名单：数据库 Tool

数据库 Tool 的核心安全约束是"只允许 SELECT，且限制表"：

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import Database from "better-sqlite3";  // 同步 SQLite，演示用

const ALLOWED_TABLES = new Set(["users", "orders", "products"]);
const FORBIDDEN_KEYWORDS = ["DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "CREATE", "TRUNCATE", "GRANT"];

class SafeSqlTool {
  private db: Database.Database;

  constructor(dbPath: string) {
    // 关键：开只读连接，物理上无法写
    this.db = new Database(dbPath, { readonly: true });
  }

  asLangChainTool() {
    return tool(
      async ({ sql, limit }) => {
        const normalized = sql.trim().toUpperCase();

        // 1. 必须是 SELECT
        if (!normalized.startsWith("SELECT")) {
          return JSON.stringify({ error: "仅允许 SELECT 查询" });
        }

        // 2. 禁止危险关键词（双保险，物理上只读已经挡了 99%）
        for (const keyword of FORBIDDEN_KEYWORDS) {
          // 简单 \b 匹配，避免匹配到字段名里的子串
          const regex = new RegExp(`\\b${keyword}\\b`);
          if (regex.test(normalized)) {
            return JSON.stringify({
              error: `查询包含禁用关键词: ${keyword}`,
            });
          }
        }

        // 3. 禁止多语句
        const stripped = normalized.replace(/;?\s*$/, "");
        if (stripped.includes(";")) {
          return JSON.stringify({ error: "不允许多语句执行" });
        }

        // 4. 强制 LIMIT
        const limitedSql = normalized.includes("LIMIT")
          ? sql
          : `${sql} LIMIT ${limit}`;

        try {
          const rows = this.db.prepare(limitedSql).all();
          return JSON.stringify({
            success: true,
            rowCount: rows.length,
            rows,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "查询失败",
          });
        }
      },
      {
        name: "sql_query",
        description: `对业务数据库执行 SQL SELECT 查询。
可用表：users, orders, products。
只允许 SELECT，禁止 DROP/DELETE/UPDATE/INSERT 等。`,
        schema: z.object({
          sql: z.string().describe("SQL SELECT 语句"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe("结果限制，最大 100"),
        }),
      }
    );
  }
}
```

更严格的方案是用 ORM（Prisma、Drizzle）暴露固定的查询接口，而不是让模型直接写 SQL。模型只能选"哪个查询 + 什么参数"，写不出新的 SQL。

### 代码沙箱：执行 Tool

让 Agent 执行代码是又强又险的能力。Node.js 的 `vm` 模块隔离性不够，我推荐 `isolated-vm` 或者干脆用 Docker container：

```typescript
// code-exec-tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import ivm from "isolated-vm";

export const executeJsTool = tool(
  async ({ code }) => {
    const isolate = new ivm.Isolate({ memoryLimit: 32 });  // 32MB 内存上限
    try {
      const context = await isolate.createContext();
      const jail = context.global;

      // 只暴露安全的全局对象
      await jail.set("log", new ivm.Reference((arg: any) => console.log(arg)));

      const script = await isolate.compileScript(code);
      const result = await script.run(context, {
        timeout: 5000,  // 5 秒超时
        copy: true,
      });

      return JSON.stringify({
        success: true,
        result: result === undefined ? null : result,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "执行失败",
      });
    } finally {
      isolate.dispose();
    }
  },
  {
    name: "execute_js",
    description:
      "在隔离沙箱中执行 JavaScript 表达式。32MB 内存，5 秒超时。无文件系统、无网络访问。",
    schema: z.object({
      code: z.string().describe("要执行的 JavaScript 代码"),
    }),
  }
);
```

> 提醒：`isolated-vm` 比内置 `vm` 安全得多，但仍不是 100% 安全。涉及不受信任输入的代码执行，最稳的方案是把执行放进 Docker container 或 Firecracker microVM。

## 6. 权限控制：基于用户角色

Agent 的工具不是"全员可见、全员可用"。我会在 Tool 内部检查调用者角色：

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

interface UserContext {
  userId: string;
  role: "admin" | "editor" | "viewer";
  permissions: Set<string>;
}

class AdminActionTool extends StructuredTool {
  name = "admin_action";
  description = "执行管理员操作（需要 admin 权限）";

  schema = z.object({
    action: z.enum(["restart_service", "purge_cache", "rotate_keys"]),
  });

  constructor(private user: UserContext) {
    super();
  }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    if (this.user.role !== "admin") {
      return JSON.stringify({
        error: "FORBIDDEN",
        message: "此操作需要管理员权限",
      });
    }

    if (!this.user.permissions.has(input.action)) {
      return JSON.stringify({
        error: "FORBIDDEN",
        message: `用户无权执行 ${input.action}`,
      });
    }

    // 实际执行...
    return JSON.stringify({ success: true, action: input.action });
  }
}
```

每个请求实例化一个新的 Tool，把当前用户的 context 注入进去。这样每个 Agent 会话的工具集合实际上是为这个用户量身定制的。

## 7. 完整集成示例

把上面这些模式组合到一个真实的 Agent 上——电商运营助手：

```typescript
// integrated-agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createRestTool } from "./rest-tool-factory";
import { SlidingWindowLimiter, withRateLimit } from "./rate-limiter";

// 1. 查询订单：REST + 认证 + 限流
const queryOrders = withRateLimit(
  createRestTool({
    name: "query_orders",
    description: "查询订单列表，可按状态过滤",
    schema: z.object({
      status: z
        .enum(["pending", "shipped", "completed", "cancelled"])
        .optional()
        .describe("订单状态过滤"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    baseURL: process.env.SHOP_API_BASE!,
    endpoint: "/orders",
    method: "GET",
    auth: { type: "bearer", token: process.env.SHOP_API_TOKEN! },
    buildQuery: (input) => ({
      status: input.status ?? "",
      limit: String(input.limit),
    }),
    timeout: 5000,
    maxRetries: 2,
  }),
  new SlidingWindowLimiter(30, 60000)  // 每分钟 30 次
);

// 2. 库存查询：带降级的工厂
const checkInventory = createRestTool({
  name: "check_inventory",
  description: "查询商品库存状态",
  schema: z.object({
    productId: z.string().describe("商品 ID"),
  }),
  baseURL: process.env.INVENTORY_API_BASE!,
  endpoint: "/inventory/:id",
  method: "GET",
  auth: { type: "apiKey", header: "X-API-Key", key: process.env.INVENTORY_API_KEY! },
  buildPath: ({ productId }) => `/inventory/${productId}`,
  timeout: 3000,
  maxRetries: 2,
  fallback: ({ productId }) =>
    JSON.stringify({
      success: false,
      error: "库存服务暂时不可用",
      hint: `请稍后查询 ${productId} 的库存，或联系运营手动处理`,
    }),
});

// 3. 业务告警：自定义 Tool
const sendAlert = tool(
  async ({ channel, message, priority }) => {
    // 真实场景调 Slack / 飞书 / 邮件 API
    console.log(`[${priority.toUpperCase()}] -> ${channel}: ${message}`);
    return JSON.stringify({
      success: true,
      channel,
      priority,
      sentAt: new Date().toISOString(),
    });
  },
  {
    name: "send_alert",
    description: "向运营团队发送告警",
    schema: z.object({
      channel: z.string().describe("Slack 频道，如 '#ops-alerts'"),
      message: z.string().describe("告警内容"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    }),
  }
);

// 4. 组装 Agent
const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [queryOrders, checkInventory, sendAlert],
  systemPrompt: `你是电商运营助手。可以查订单、查库存、发告警。
原则：
1. 发现低库存（< 10）或缺货时，必须向 #ops-alerts 发送 high 优先级告警
2. 告警内容要包含商品 ID 和当前库存数
3. 操作完成后简短总结结果`,
});

// 5. 跑一个真实任务
const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "查一下今天 pending 状态的订单，然后挑出涉及的商品检查库存，发现库存不足的发告警",
    },
  ],
});

console.log(result.messages.at(-1)?.content);
```

这个 Agent 里同时用到了 REST 工厂、Bearer 认证、API key 认证、限流、降级、自定义 Tool——全部通过 `createAgent({ model, tools })` 一次注入，没有 `.bindTools()`，没有手写循环。

## 8. 上线前的安全检查清单

我把每个 Tool 部署前都过一遍下面这个清单：

| 检查项 | 关键问题 |
|--------|----------|
| 输入验证 | Zod schema 是否限制了字符串长度、数字范围、枚举值？ |
| 路径安全 | 文件操作是否用了 `validatePath`？符号链接也挡住了吗？ |
| SQL 安全 | 数据库连接是否只读？关键词过滤是否双保险？ |
| 代码沙箱 | 隔离层是否完整？内存、超时、API 暴露面是否受限？ |
| 认证 | API key 是否从环境变量读？日志里会泄露 token 吗？ |
| 限流 | 是否按调用者维度独立计数？滑动窗口是否清理过期记录？ |
| 超时 | 单次请求、整个 Tool、整个 Agent 三层超时是否都设了？ |
| 降级 | 主链路失败时是否有 fallback？降级后返回的信息对模型有用吗？ |
| 错误处理 | 业务错误是否都返回结构化 JSON，没有让 Agent 中断？ |
| 权限 | 工具是否检查了调用者角色？只读和写入是否分开？ |
| 审计 | 关键操作是否记日志？日志里有 user_id、trace_id 吗？ |
| 只读优先 | 写操作是否真的必要？能否退化为"生成命令让人工执行"？ |

## 小结

外部系统集成不是"调通就行"。生产级的工具集要在五个维度上扛得住：

1. **批量化**：REST 工厂消灭重复代码
2. **认证**：API key、Bearer、OAuth、签名各得其所
3. **限流**：滑动窗口或令牌桶，按用户独立计数
4. **降级**：超时金字塔 + fallback 链 + 熔断（网关层）
5. **安全**：路径沙箱、SQL 白名单、代码隔离、权限检查

模块 04 到此结束。你已经掌握了 Tool 定义、生产实现、跨厂商统一、MCP 生态、安全集成——一个 Agent 需要的所有"动作能力"。下一模块 [05-Agent 架构](../05-agent-architecture/create-agent.md) 把 model、tools、memory 组装成完整的 Agent 系统，重点讲 `createAgent` 内部的 LangGraph 循环、middleware、ReAct / Plan-and-Execute 等架构模式。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
