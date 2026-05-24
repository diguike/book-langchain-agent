---
title: 自定义 Tool 开发
feishu_url: ""
last_synced: ""
---

> 模块 04 - 工具与函数调用 | 前置：[Tool 接口与定义](./tool-interface.md) | 后续：[Function Calling 跨模型统一](./function-calling.md)

## 从原型到生产的距离

上一节我用 `tool()` helper 写了一个查天气的 Tool，几十行代码就能跑。但放到生产环境之前，至少还差五件事：超时、重试、并发控制、错误恢复、测试。这一节专门讲怎么把一个能跑的 Tool 升级成能扛流量、能上线的 Tool。

我会按从简单到复杂的顺序展开：

1. 异步 + 超时
2. 重试与降级
3. 并发控制
4. 测试策略
5. 完整的 CRUD 工具集
6. REST 工厂函数（一个配置生成一个 Tool）

代码全部基于 LangChain.js 1.x，Node.js 22+。

## 异步 + 超时

几乎所有真实场景的 Tool 都是异步的——API 调用、数据库查询、文件读写。我用 `AbortSignal.timeout()` 处理超时，比手写 `setTimeout` 干净得多：

```typescript
// fetch-user-tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const fetchUser = tool(
  async ({ userId }) => {
    try {
      const response = await fetch(`https://api.example.com/users/${userId}`, {
        signal: AbortSignal.timeout(5000),  // 5 秒超时
        headers: { Authorization: `Bearer ${process.env.API_KEY}` },
      });

      if (response.status === 404) {
        return JSON.stringify({ success: false, error: "NOT_FOUND" });
      }
      if (!response.ok) {
        return JSON.stringify({
          success: false,
          error: "HTTP_ERROR",
          status: response.status,
        });
      }

      const user = await response.json();
      return JSON.stringify({ success: true, user });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return JSON.stringify({ success: false, error: "TIMEOUT" });
      }
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  {
    name: "fetch_user",
    description: "根据用户 ID 从系统中获取用户详细信息",
    schema: z.object({
      userId: z.string().describe("用户 ID"),
    }),
  }
);
```

注意几个点：

- 用 `AbortSignal.timeout(ms)` 一行搞定超时，Node.js 22+ 原生支持
- catch 里区分 `TimeoutError` 和其他错误，返回不同的结构化信息给模型
- HTTP 状态码也按业务语义分类（404 → NOT_FOUND，429 → RATE_LIMITED）

## 重试与降级

外部 API 偶发抖动是常态。一个生产级 Tool 应该自己处理瞬时失败，不要把所有压力都推给模型。我会封装一个通用的 `httpRequest`：

```typescript
// http-client.ts
interface HttpOptions extends RequestInit {
  maxRetries?: number;
  timeout?: number;
  retryOn?: number[];  // 哪些状态码触发重试
}

async function httpRequest(
  url: string,
  options: HttpOptions = {}
): Promise<{ status: number; data: any }> {
  const {
    maxRetries = 2,
    timeout = 10000,
    retryOn = [429, 500, 502, 503, 504],
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(timeout),
      });

      // 状态码触发重试
      if (retryOn.includes(response.status) && attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);  // 指数退避，封顶 8 秒
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const data = await response.json().catch(() => null);
      return { status: response.status, data };
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw lastError ?? new Error("请求失败");
}
```

把它用进 Tool：

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const searchGitHubRepos = tool(
  async ({ query, language, sort }) => {
    const params = new URLSearchParams({
      q: language ? `${query} language:${language}` : query,
      sort,
      per_page: "5",
    });

    try {
      const { status, data } = await httpRequest(
        `https://api.github.com/search/repositories?${params}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
          },
          maxRetries: 2,
          timeout: 8000,
        }
      );

      if (status !== 200) {
        return JSON.stringify({
          success: false,
          error: `GitHub API 返回 ${status}`,
          details: data,
        });
      }

      const repos = data.items.map((r: any) => ({
        name: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        url: r.html_url,
        language: r.language,
      }));

      return JSON.stringify({ success: true, total: data.total_count, repos });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "请求失败",
      });
    }
  },
  {
    name: "search_github_repos",
    description: "在 GitHub 上搜索代码仓库，可按编程语言过滤、按 stars 或更新时间排序",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
      language: z.string().optional().describe("编程语言过滤，如 'typescript'"),
      sort: z
        .enum(["stars", "updated", "forks"])
        .default("stars")
        .describe("排序方式"),
    }),
  }
);
```

## 并发控制

Agent 可能在一轮里并行调用多个工具（详见 [Function Calling 跨模型统一](./function-calling.md)）。如果每个 Tool 内部还有自己的并发逻辑——比如批量查询——叠加之后很容易把后端打爆。

我用 `p-limit` 限流：

```bash
npm install p-limit
```

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import pLimit from "p-limit";

const limit = pLimit(3);  // 同时最多 3 个并发请求

const batchFetchProducts = tool(
  async ({ productIds }) => {
    const results = await Promise.all(
      productIds.map((id) =>
        limit(async () => {
          const response = await fetch(`https://api.shop.com/products/${id}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) {
            return { id, error: `HTTP ${response.status}` };
          }
          return await response.json();
        })
      )
    );

    return JSON.stringify({ count: results.length, products: results });
  },
  {
    name: "batch_fetch_products",
    description: "批量查询商品信息。一次最多查 20 个商品。",
    schema: z.object({
      productIds: z
        .array(z.string())
        .max(20)
        .describe("商品 ID 列表，最多 20 个"),
    }),
  }
);
```

注意 schema 里用 `.max(20)` 把上界写死——这是给模型的护栏，避免它一次塞 1000 个 ID 进来。

## 依赖注入：什么时候用 class

`tool()` helper 用闭包能搞定大部分依赖注入。但如果你的 Tool 需要：

- 共享一个长连接（数据库、Redis）
- 在测试里方便地 mock 依赖
- 多个相关 Tool 共享同一组配置

那继承 `StructuredTool` 会更清晰：

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

interface HttpClientConfig {
  baseURL: string;
  apiKey: string;
  timeout?: number;
}

class ApiClientTool extends StructuredTool {
  name = "api_client";
  description = "向业务 API 发送请求并返回结果";

  schema = z.object({
    endpoint: z.string().describe("API 端点路径，如 '/users/123'"),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
    body: z.string().optional().describe("请求体 JSON 字符串"),
  });

  constructor(private config: HttpClientConfig) {
    super();
  }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    const { endpoint, method, body } = input;
    const url = `${this.config.baseURL}${endpoint}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: body ?? undefined,
        signal: AbortSignal.timeout(this.config.timeout ?? 10000),
      });

      if (!response.ok) {
        return JSON.stringify({
          success: false,
          status: response.status,
          error: await response.text(),
        });
      }

      const data = await response.json();
      return JSON.stringify({ success: true, data });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "请求失败",
      });
    }
  }
}

// 注入配置创建实例
const apiTool = new ApiClientTool({
  baseURL: "https://api.myservice.com/v1",
  apiKey: process.env.API_KEY!,
  timeout: 5000,
});
```

## 测试策略

Tool 本质上是一个函数，测试起来非常直接。我用 Vitest，因为它跟 Node.js 22+ 的 ESM 兼容性最好：

```bash
npm install -D vitest
```

```typescript
// order-tool.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 把工具的创建抽成工厂函数，方便测试时注入 mock
interface OrderDb {
  findProduct(id: string): Promise<{ id: string; stock: number; price: number } | null>;
  createOrder(data: { productId: string; quantity: number }): Promise<{ id: string }>;
}

function createOrderTool(db: OrderDb) {
  return tool(
    async ({ productId, quantity }) => {
      const product = await db.findProduct(productId);
      if (!product) {
        return JSON.stringify({ success: false, error: "商品不存在" });
      }
      if (product.stock < quantity) {
        return JSON.stringify({ success: false, error: "库存不足" });
      }
      const order = await db.createOrder({ productId, quantity });
      return JSON.stringify({ success: true, orderId: order.id });
    },
    {
      name: "create_order",
      description: "创建订单",
      schema: z.object({
        productId: z.string().describe("商品 ID"),
        quantity: z.number().int().positive().describe("购买数量"),
      }),
    }
  );
}

describe("createOrderTool", () => {
  let mockDb: OrderDb;
  let orderTool: ReturnType<typeof createOrderTool>;

  beforeEach(() => {
    mockDb = {
      findProduct: vi.fn(),
      createOrder: vi.fn(),
    };
    orderTool = createOrderTool(mockDb);
  });

  it("成功创建订单", async () => {
    (mockDb.findProduct as any).mockResolvedValue({ id: "p1", stock: 100, price: 99 });
    (mockDb.createOrder as any).mockResolvedValue({ id: "order-001" });

    const result = await orderTool.invoke({ productId: "p1", quantity: 2 });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.orderId).toBe("order-001");
    expect(mockDb.createOrder).toHaveBeenCalledWith({
      productId: "p1",
      quantity: 2,
    });
  });

  it("商品不存在时返回错误", async () => {
    (mockDb.findProduct as any).mockResolvedValue(null);

    const result = await orderTool.invoke({ productId: "invalid", quantity: 1 });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("商品不存在");
  });

  it("库存不足时返回错误", async () => {
    (mockDb.findProduct as any).mockResolvedValue({ id: "p1", stock: 1, price: 99 });

    const result = await orderTool.invoke({ productId: "p1", quantity: 10 });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("库存不足");
  });

  it("schema 校验：负数 quantity 会被拒绝", async () => {
    await expect(orderTool.invoke({ productId: "p1", quantity: -1 })).rejects.toThrow();
  });

  it("有正确的元数据", () => {
    expect(orderTool.name).toBe("create_order");
    expect(orderTool.description).toContain("创建订单");
  });
});
```

测试 Tool 的几个关键点：

1. **把工具创建抽成工厂函数**，方便注入 mock 依赖
2. **校验返回 JSON 的结构**，不只是 truthy/falsy
3. **测 schema 边界**——给非法输入，验证 Zod 是否真的拦住
4. **覆盖错误分支**——业务错误返回正确的错误码，不能是 generic 的 "failed"

## 完整 CRUD 工具集

下面是一个完整的用户管理工具集，用 `Map` 模拟数据库（生产里换成真实 DB 连接）：

```typescript
// user-tools.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

// 注意：以下用 Map 模拟数据库，仅供功能演示。
// 生产环境请替换为 Postgres / Redis 等持久化存储。
const users = new Map<string, User>();
let nextId = 1;

export const createUserTool = tool(
  async ({ name, email, role }) => {
    for (const user of users.values()) {
      if (user.email === email) {
        return JSON.stringify({ success: false, error: `邮箱 ${email} 已被注册` });
      }
    }
    const id = `user_${nextId++}`;
    const user: User = { id, name, email, role };
    users.set(id, user);
    return JSON.stringify({ success: true, user });
  },
  {
    name: "create_user",
    description: "创建新用户。需要提供姓名、邮箱和角色。邮箱必须唯一。",
    schema: z.object({
      name: z.string().describe("用户姓名"),
      email: z.string().email().describe("用户邮箱地址"),
      role: z.enum(["admin", "editor", "viewer"]).describe("用户角色"),
    }),
  }
);

export const getUserTool = tool(
  async ({ userId }) => {
    const user = users.get(userId);
    if (!user) {
      return JSON.stringify({ success: false, error: `用户 ${userId} 不存在` });
    }
    return JSON.stringify({ success: true, user });
  },
  {
    name: "get_user",
    description: "根据用户 ID 查询用户详细信息",
    schema: z.object({
      userId: z.string().describe("用户 ID，格式为 user_xxx"),
    }),
  }
);

export const updateUserTool = tool(
  async ({ userId, name, email, role }) => {
    const user = users.get(userId);
    if (!user) {
      return JSON.stringify({ success: false, error: `用户 ${userId} 不存在` });
    }
    if (name) user.name = name;
    if (email) user.email = email;
    if (role) user.role = role;
    return JSON.stringify({ success: true, user });
  },
  {
    name: "update_user",
    description: "更新现有用户的信息。只需提供要修改的字段。",
    schema: z.object({
      userId: z.string().describe("要更新的用户 ID"),
      name: z.string().optional().describe("新的姓名"),
      email: z.string().email().optional().describe("新的邮箱"),
      role: z.enum(["admin", "editor", "viewer"]).optional().describe("新的角色"),
    }),
  }
);

export const deleteUserTool = tool(
  async ({ userId }) => {
    if (!users.has(userId)) {
      return JSON.stringify({ success: false, error: `用户 ${userId} 不存在` });
    }
    users.delete(userId);
    return JSON.stringify({ success: true, message: `用户 ${userId} 已删除` });
  },
  {
    name: "delete_user",
    description: "根据用户 ID 删除用户。此操作不可逆。",
    schema: z.object({
      userId: z.string().describe("要删除的用户 ID"),
    }),
  }
);

export const listUsersTool = tool(
  async ({ role, page, pageSize }) => {
    let result = Array.from(users.values());
    if (role) result = result.filter((u) => u.role === role);

    const total = result.length;
    const start = (page - 1) * pageSize;
    const paged = result.slice(start, start + pageSize);

    return JSON.stringify({
      success: true,
      users: paged,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  },
  {
    name: "list_users",
    description: "列出系统中的用户，支持按角色过滤和分页",
    schema: z.object({
      role: z.enum(["admin", "editor", "viewer"]).optional().describe("按角色过滤"),
      page: z.number().int().positive().default(1).describe("页码，从 1 开始"),
      pageSize: z.number().int().min(1).max(100).default(20).describe("每页数量"),
    }),
  }
);

export const userTools = [
  createUserTool,
  getUserTool,
  updateUserTool,
  deleteUserTool,
  listUsersTool,
];
```

整个工具集就是一个数组，下一模块直接 `createAgent({ model, tools: userTools })` 就能用，不需要 `.bindTools()`。

## REST 工厂：一个配置生成一个 Tool

如果团队有几十个 REST API 要包装成 Tool，手写 boilerplate 会非常痛苦。我用一个工厂函数批量生成：

```typescript
// rest-tool-factory.ts
import { tool } from "@langchain/core/tools";
import { z, ZodObject, ZodRawShape } from "zod";

interface RestToolConfig<T extends ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<T>;
  baseURL: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  // 从 input 生成请求体
  buildBody?: (input: z.infer<ZodObject<T>>) => unknown;
  // 从 input 生成路径（支持 :id 这种参数）
  buildPath?: (input: z.infer<ZodObject<T>>) => string;
  // 从 input 生成 query string
  buildQuery?: (input: z.infer<ZodObject<T>>) => Record<string, string>;
  timeout?: number;
  maxRetries?: number;
}

export function createRestTool<T extends ZodRawShape>(config: RestToolConfig<T>) {
  return tool(
    async (input) => {
      const path = config.buildPath ? config.buildPath(input) : config.endpoint;
      const query = config.buildQuery
        ? "?" + new URLSearchParams(config.buildQuery(input)).toString()
        : "";
      const url = `${config.baseURL}${path}${query}`;

      const fetchOptions: RequestInit = {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        signal: AbortSignal.timeout(config.timeout ?? 10000),
      };

      if (config.method !== "GET" && config.buildBody) {
        fetchOptions.body = JSON.stringify(config.buildBody(input));
      }

      const maxRetries = config.maxRetries ?? 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, fetchOptions);
          const data = await response.json().catch(() => null);

          // 5xx 触发重试
          if (response.status >= 500 && attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            continue;
          }

          if (!response.ok) {
            return JSON.stringify({
              success: false,
              status: response.status,
              error: data,
            });
          }

          return JSON.stringify({ success: true, data });
        } catch (error) {
          if (attempt >= maxRetries) {
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "请求失败",
            });
          }
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
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

用法：

```typescript
const getOrder = createRestTool({
  name: "get_order",
  description: "根据订单 ID 查询订单详情",
  schema: z.object({
    orderId: z.string().describe("订单 ID"),
  }),
  baseURL: "https://api.myshop.com",
  endpoint: "/orders/:id",
  method: "GET",
  headers: { Authorization: `Bearer ${process.env.SHOP_API_KEY}` },
  buildPath: ({ orderId }) => `/orders/${orderId}`,
});

const createOrder = createRestTool({
  name: "create_order",
  description: "创建新订单",
  schema: z.object({
    productId: z.string().describe("商品 ID"),
    quantity: z.number().int().positive().describe("数量"),
    shippingAddress: z.string().describe("收货地址"),
  }),
  baseURL: "https://api.myshop.com",
  endpoint: "/orders",
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.SHOP_API_KEY}` },
  buildBody: (input) => ({
    product_id: input.productId,
    qty: input.quantity,
    address: input.shippingAddress,
  }),
});
```

这个工厂会在下一节 [外部系统集成模式](./external-integration.md) 进一步扩展为完整的集成框架。

## 小结

生产级 Tool 的清单：

| 维度 | 做法 |
|------|------|
| 超时 | `AbortSignal.timeout(ms)` |
| 重试 | 指数退避，只重试可恢复错误（5xx、429、network） |
| 并发 | `p-limit` 控制单 Tool 内的并发数 |
| 错误处理 | 返回结构化 JSON，业务错误不抛异常 |
| 测试 | 工厂函数注入 mock，覆盖正常路径和所有错误分支 |
| 依赖注入 | 简单场景用闭包，复杂场景继承 `StructuredTool` |
| REST 包装 | 用工厂函数批量生成，避免 boilerplate |

下一节 [Function Calling 跨模型统一](./function-calling.md) 讨论如何把同一套 Tool 在 Anthropic、OpenAI、Google 三家模型上跑出一致的行为。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
