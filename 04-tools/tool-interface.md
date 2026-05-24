---
title: Tool 接口与定义
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/WEXOwLSW8iGMY1krTUtcgzV3njg"
last_synced: "2026-05-25T02:41:41+08:00"
---

> 模块 04 - 工具与函数调用 | 前置知识：[03-记忆系统](../03-memory/memory-overview.md) | 后续：[自定义 Tool 开发](./custom-tool.md)、[Function Calling 跨模型统一](./function-calling.md)

## Tool 是什么

Tool 是 Agent 的动作集合。模型只能输出文本，没法直接查数据库、调 API、写文件——这些"实际能做事"的能力都由 Tool 承担。在 LangChain.js 1.x 里，一个 Tool 就是三样东西的打包：

1. **元信息**：`name`（唯一标识）+ `description`（让模型读懂"什么时候用"）
2. **输入 schema**：用 Zod 描述参数的结构和约束
3. **执行函数**：拿到模型生成的参数，跑出结果

我在写这一章时一直在提醒自己一件事：Tool 的好坏决定 Agent 的好坏。模型再聪明，给的工具描述模糊、schema 不严，照样选错、传错参数。

> 官方参考：[LangChain Tools 文档](https://docs.langchain.com/oss/javascript/integrations/tools/)、[Zod schema 库](https://zod.dev/)

## 第一个 Tool：30 行代码

我先装包：

```bash
npm install @langchain/core zod
```

然后写一个查天气的 Tool：

```typescript
// weather-tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async ({ city, unit }) => {
    // 这里真实项目应该调天气 API，演示用假数据
    const data: Record<string, { temp: number; condition: string }> = {
      北京: { temp: 18, condition: "晴" },
      上海: { temp: 22, condition: "多云" },
    };
    const found = data[city];
    if (!found) {
      return JSON.stringify({ error: `未找到城市 "${city}"` });
    }
    const temp = unit === "fahrenheit" ? (found.temp * 9) / 5 + 32 : found.temp;
    return JSON.stringify({
      city,
      temperature: temp,
      unit,
      condition: found.condition,
    });
  },
  {
    name: "get_weather",
    description: "查询某个城市的实时天气，包含温度和天气状况。支持的城市：北京、上海。",
    schema: z.object({
      city: z.string().describe("城市名，如 '北京'"),
      unit: z
        .enum(["celsius", "fahrenheit"])
        .default("celsius")
        .describe("温度单位"),
    }),
  }
);

// 直接调用测试
const result = await getWeather.invoke({ city: "北京", unit: "celsius" });
console.log(result);
// 输出: {"city":"北京","temperature":18,"unit":"celsius","condition":"晴"}
```

跑一下：

```bash
npx tsx weather-tool.ts
```

这就是 1.x 推荐的 Tool 定义方式——`tool()` helper 函数。第一个参数是执行函数，第二个参数是元信息。

## `tool()` helper 的完整签名

```typescript
tool(
  // 执行函数：接收 schema 解析后的输入，返回 string 或 ToolMessage
  async (input: z.infer<typeof schema>) => string | ToolMessage,
  {
    name: string,                  // 必填：工具唯一标识，模型用它发起调用
    description: string,           // 必填：工具描述，模型靠它判断何时调用
    schema: z.ZodObject<any>,      // 必填：Zod 输入 schema
    returnDirect?: boolean,        // 可选：是否跳过模型总结直接返回
    verbose?: boolean,             // 可选：详细日志
  }
)
```

返回值是一个 `StructuredTool` 实例，可以：

- 用 `.invoke(input)` 直接执行
- 放进数组传给 `createAgent({ tools: [...] })`，让 Agent 内部统一调度

我在 [05-Agent 架构](../05-agent-architecture/create-agent.md) 里会展开 `createAgent` 怎么用，这里只需要记住：**1.x 里不要手动 `.bindTools()`，把 tools 数组直接传给 `createAgent` 就行**。

## Zod schema：参数描述的艺术

Tool schema 不只是类型校验，更重要的是给模型读的文档。每个 `.describe()` 都直接进入模型上下文，影响模型决策。

写得好的 schema：

```typescript
const searchSchema = z.object({
  query: z.string().describe("搜索关键词，支持自然语言"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("返回结果的最大数量，默认 10"),
  category: z
    .enum(["news", "blog", "docs", "all"])
    .default("all")
    .describe("搜索类别过滤"),
  dateRange: z
    .object({
      from: z.string().describe("起始日期，格式 YYYY-MM-DD"),
      to: z.string().describe("结束日期，格式 YYYY-MM-DD"),
    })
    .optional()
    .describe("可选的日期范围过滤"),
});
```

写得不好的 schema：

```typescript
// 不要这样
const badSchema = z.object({
  q: z.string(),       // 名称缩写，没 describe，模型猜不出来是什么
  n: z.number(),       // 含义不明
  type: z.string(),    // 应该用 enum
  options: z.any(),    // any 等于没约束
});
```

五条 schema 设计原则，我每次写 Tool 都在头脑里过一遍：

1. **每个字段都加 `.describe()`**——这是模型理解参数含义的唯一途径
2. **能用 `enum` 就别用 `string`**——把模型可选的范围圈死，出错概率大幅下降
3. **设置合理的 `.default()`**——给模型一个"不确定时的安全选项"
4. **字段名用清晰的英文**——`maxResults` 优于 `n`，`userId` 优于 `id`
5. **嵌套不要超过两层**——太深的嵌套会让模型生成参数时出错

## 输入输出类型约束

### 输入：始终是结构化对象

`tool()` 内部会用 schema 解析模型传来的参数，所以你的执行函数拿到的 `input` 是已经按 schema 解析过、类型严格的对象。TypeScript 会自动推导：

```typescript
const example = tool(
  async (input) => {
    // input 的类型由 schema 推导，编辑器有完整提示
    // input.name: string, input.count: number
    return `处理 ${input.name}，数量 ${input.count}`;
  },
  {
    name: "example",
    description: "示例工具",
    schema: z.object({
      name: z.string(),
      count: z.number(),
    }),
  }
);
```

### 输出：string 或 ToolMessage

最简单是直接返回 string。如果返回结构化数据，序列化成 JSON 字符串：

```typescript
const fetchUser = tool(
  async ({ userId }) => {
    const user = await db.findUser(userId);
    return JSON.stringify(user);  // 结构化数据序列化为字符串
  },
  {
    name: "fetch_user",
    description: "根据用户 ID 获取用户信息",
    schema: z.object({
      userId: z.string().describe("用户 ID"),
    }),
  }
);
```

1.x 里 Tool 也可以返回 `ToolMessage` 对象，用 `artifact` 字段携带额外结构化产物（比如生成的图片二进制、大型对象引用），但 99% 的场景返回 string 就够了。

## 错误处理：返回错误，不要抛异常

这是 Tool 设计里最容易踩的坑。我的原则：**业务错误返回结构化的错误信息，让模型决定下一步；只有不可恢复的错误才抛异常**。

为什么？因为模型本身就是一个状态机，它读了 Tool 返回的错误信息后能改变策略——比如换个参数重试、换个工具、向用户澄清。直接抛异常的话，整个 Agent 循环就中断了。

对比一下：

```typescript
// 不推荐：直接抛异常，Agent 循环中断
const badTool = tool(
  async ({ url }) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);  // 整个 Agent 中断
    }
    return await response.text();
  },
  { name: "fetch_url", description: "抓取 URL 内容", schema: z.object({ url: z.string().url() }) }
);

// 推荐：返回结构化错误，模型自己判断
const goodTool = tool(
  async ({ url }) => {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        return JSON.stringify({
          success: false,
          error: "NOT_FOUND",
          message: `URL ${url} 不存在`,
        });
      }
      if (response.status === 429) {
        return JSON.stringify({
          success: false,
          error: "RATE_LIMITED",
          message: "请求频率超限，建议稍后重试",
        });
      }
      if (!response.ok) {
        return JSON.stringify({
          success: false,
          error: "HTTP_ERROR",
          message: `HTTP ${response.status} ${response.statusText}`,
        });
      }

      const text = await response.text();
      return JSON.stringify({ success: true, content: text.slice(0, 5000) });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return JSON.stringify({
          success: false,
          error: "TIMEOUT",
          message: "请求超时",
        });
      }
      // 真正不可恢复的错误（比如配置错误）才抛
      throw error;
    }
  },
  {
    name: "fetch_url",
    description: "获取指定 URL 的内容，返回成功结果或结构化的错误信息",
    schema: z.object({
      url: z.string().url().describe("完整 URL"),
    }),
  }
);
```

错误处理的分类表，我每次写 Tool 都按这个走：

| 错误类型 | 处理方式 | 原因 |
|----------|----------|------|
| 业务错误（404、参数无效、记录不存在） | 返回错误 JSON | 模型能理解并调整策略 |
| 临时错误（超时、限流） | 返回错误 JSON + 重试建议 | 模型可以选择等待或换方案 |
| 致命错误（配置缺失、代码 bug） | 抛异常 | 需要开发者介入修复 |

## returnDirect 与 verbose

`returnDirect: true` 让 Tool 的输出**直接返回给用户**，跳过模型的总结步骤：

```typescript
const calculator = tool(
  async ({ expression }) => {
    return `计算结果：${Function(`"use strict"; return (${expression})`)()}`;
  },
  {
    name: "calculator",
    description: "计算数学表达式",
    schema: z.object({
      expression: z.string().describe("数学表达式，如 '2 + 3 * 4'"),
    }),
    returnDirect: true,  // 直接返回计算结果，不再让模型加工
  }
);
```

适用场景：

- 工具输出已经是用户可读的最终答案（计算器、格式化报表）
- 想减少一次 LLM 调用降低延迟和成本
- 返回的是链接、文件路径等需要保持原样的内容

`verbose: true` 在控制台打印工具调用的详细日志，调试时打开，生产环境关掉。

## 何时不用 `tool()`，改用 class

`tool()` 是 1.x 主流写法，覆盖 90% 的场景。但有两种情况我会改用继承 `StructuredTool`：

1. **需要注入依赖**：数据库连接、API client、配置对象——这些通过构造函数传更干净
2. **多个 Tool 共享一组方法**：同一个服务下的 CRUD 操作可以抽到一个基类里

class 写法的样板：

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

interface DbConfig {
  host: string;
  apiKey: string;
}

class UserQueryTool extends StructuredTool {
  name = "query_user";
  description = "根据用户 ID 查询用户信息";

  // 注意：schema 字段类型用 ReturnType 或显式写出
  schema = z.object({
    userId: z.string().describe("用户 ID"),
  });

  constructor(private config: DbConfig) {
    super();
  }

  // _call 是必须实现的方法
  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    const response = await fetch(`${this.config.host}/users/${input.userId}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!response.ok) {
      return JSON.stringify({ error: `HTTP ${response.status}` });
    }
    const user = await response.json();
    return JSON.stringify(user);
  }
}

// 使用：注入配置
const userTool = new UserQueryTool({
  host: "https://api.example.com",
  apiKey: process.env.API_KEY!,
});
```

下一章 [自定义 Tool 开发](./custom-tool.md) 会把这种模式扩展到 CRUD 工具集、REST 工厂、带重试和超时的生产级实现。

## 内置工具一览

LangChain.js 生态自带一批开箱即用的 Tool，常用的有：

| 工具 | 包 | 功能 |
|------|------|------|
| `TavilySearch` | `@langchain/community/tools/tavily_search` | Tavily 搜索引擎 |
| `SerpAPI` | `@langchain/community/tools/serpapi` | Google 搜索结果 |
| `WikipediaQueryRun` | `@langchain/community/tools/wikipedia_query_run` | Wikipedia 查询 |
| `DuckDuckGoSearch` | `@langchain/community/tools/duckduckgo_search` | DuckDuckGo 搜索 |
| `WebBrowser` | `langchain/tools/webbrowser` | 浏览网页并提取内容 |

完整列表见 [LangChain Tools 集成文档](https://docs.langchain.com/oss/javascript/integrations/tools/)。

```typescript
import { TavilySearch } from "@langchain/community/tools/tavily_search";

const search = new TavilySearch({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

const results = await search.invoke("LangChain.js 1.x 最新特性");
```

## 工具不被调用？最常见的三个原因

新手最容易遇到的问题：定义好了工具，结果模型完全不调，直接编了答案。我整理过统计，按出现频率排序：

1. **`description` 太模糊**——`"查天气"` 不行，`"查询指定城市的实时天气，输入是城市名（中文或英文）"` 才行。模型读 description 决定要不要调。
2. **没强调"必须用工具"**——在 system prompt 里明确写"涉及实时数据时必须调工具，不要凭记忆回答"
3. **schema 字段缺 `.describe()`**——字段含义不明，模型猜不到怎么填，干脆不调

调试的时候打开 `verbose`，或者上 [LangSmith Tracing](../07-observability/langsmith-tracing.md)，能看到模型每一步的工具决策过程。

## 小结

1.x 的 Tool 抽象就两个东西：`tool()` helper 和 Zod schema。一个 Tool = 名字 + 描述 + schema + 执行函数。错误处理用结构化返回，让模型决定下一步。Tools 数组直接交给 `createAgent`，不要自己 `.bindTools()`。

下一节 [自定义 Tool 开发](./custom-tool.md) 把这套基础扩展到生产级——重试、超时、并发、测试策略。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
