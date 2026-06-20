// 配套示例：09-projects/03-data-analysis.md（精简离线版）
// 一个数据分析 Agent：挂"对本地数组做统计"的工具，纯本地计算、无外部服务。
// 原章节用内存 SQLite + SQL 沙箱，这里换成进程内数组 + group-by 工具，
// 让示例零依赖、离线可跑，但保留"Agent 调工具做分析再用人话解读"的核心动线。
//
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// 没设 OPENAI_API_KEY 时，自动指向本地 Mock LLM Server。
function makeModel() {
  return new ChatOpenAI({
    model: "mock-claude",
    apiKey: process.env.OPENAI_API_KEY ?? "mock-key",
    temperature: 0,
    configuration: process.env.OPENAI_API_KEY
      ? undefined
      : { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1" },
  });
}

// 进程内数据集：一份订单数组，相当于"已经加载好的表"。
interface Order {
  orderId: string;
  city: string;
  amount: number;
  createdAt: string;
}

const ORDERS: Order[] = [
  { orderId: "O001", city: "北京", amount: 299, createdAt: "2026-04-12" },
  { orderId: "O002", city: "上海", amount: 1599, createdAt: "2026-04-15" },
  { orderId: "O003", city: "广州", amount: 89, createdAt: "2026-04-20" },
  { orderId: "O004", city: "北京", amount: 499, createdAt: "2026-04-22" },
  { orderId: "O005", city: "上海", amount: 239, createdAt: "2026-05-01" },
  { orderId: "O006", city: "深圳", amount: 1099, createdAt: "2026-05-03" },
];

// 工具：看清楚数据集长什么样（写聚合前的强制前置步骤）。
const inspectData = tool(
  async () => {
    return JSON.stringify({
      rowCount: ORDERS.length,
      columns: ["orderId(string)", "city(string)", "amount(number)", "createdAt(date)"],
      sample: ORDERS[0],
    });
  },
  {
    name: "inspect_data",
    description: "查看订单数据集的总行数、字段、样例行。做聚合分析前必看。",
    schema: z.object({}),
  }
);

// 工具：按某个字段分组，对 amount 做统计（纯本地计算）。
const aggregateByCity = tool(
  async ({ groupBy, metric }) => {
    if (groupBy !== "city") {
      return `当前示例只支持按 city 分组，收到 groupBy=${groupBy}`;
    }
    const buckets = new Map<string, number[]>();
    for (const o of ORDERS) {
      const arr = buckets.get(o.city) ?? [];
      arr.push(o.amount);
      buckets.set(o.city, arr);
    }
    const result = [...buckets.entries()].map(([city, amounts]) => {
      const sum = amounts.reduce((a, b) => a + b, 0);
      const count = amounts.length;
      const value =
        metric === "sum"
          ? sum
          : metric === "count"
            ? count
            : Math.round((sum / count) * 100) / 100; // avg
      return { city, value };
    });
    // 按统计值降序
    result.sort((a, b) => b.value - a.value);
    return JSON.stringify({ groupBy, metric, result });
  },
  {
    name: "aggregate_by_city",
    description: `对订单按城市分组统计。metric 可选：
- sum: 每个城市的订单总金额
- count: 每个城市的订单数
- avg: 每个城市的客单价`,
    schema: z.object({
      groupBy: z.literal("city").describe("分组字段，当前只支持 city"),
      metric: z.enum(["sum", "count", "avg"]).describe("统计指标"),
    }),
  }
);

const agent = createAgent({
  model: makeModel(),
  tools: [inspectData, aggregateByCity],
  systemPrompt: `你是数据分析助手。数据集是一份订单数组。
1. 先用 inspect_data 看清楚字段，绝不凭想象分析。
2. 用 aggregate_by_city 做分组统计。
3. 用中文给一段简洁解读，引用具体数字，不要套话。`,
});

async function main() {
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "每个城市的订单总金额是多少？哪个城市贡献最高？",
      },
    ],
  });
  console.log("=== Agent 最终解读 ===");
  console.log(result.messages.at(-1)?.text);
}

main();
