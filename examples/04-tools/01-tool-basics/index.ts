// 配套示例：04-tools/01-tool-interface.md、04-tools/02-custom-tool.md
// Tool 基础：用 tool() helper + Zod schema 定义工具，再交给 createAgent 调度。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// 没设 OPENAI_API_KEY 时，自动指向本地 Mock LLM Server（examples/_shared/mock-llm）。
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

// 一个 Tool = 名字 + 描述 + Zod schema + 执行函数。
// 每个字段都加 .describe()，这是模型理解参数含义的唯一途径。
const getWeather = tool(
  async ({ city, unit }) => {
    // 真实项目这里调天气 API，演示用假数据。
    const data: Record<string, { temp: number; condition: string }> = {
      北京: { temp: 18, condition: "晴" },
      上海: { temp: 22, condition: "多云" },
    };
    const found = data[city];
    if (!found) {
      // 业务错误返回结构化 JSON，不抛异常——让模型自己决定下一步。
      return JSON.stringify({ error: `未找到城市 "${city}"` });
    }
    const temp = unit === "fahrenheit" ? (found.temp * 9) / 5 + 32 : found.temp;
    return JSON.stringify({ city, temperature: temp, unit, condition: found.condition });
  },
  {
    name: "get_weather",
    description: "查询某个城市的实时天气，包含温度和天气状况。支持的城市：北京、上海。",
    schema: z.object({
      city: z.string().describe("城市名，如 '北京'"),
      unit: z.enum(["celsius", "fahrenheit"]).default("celsius").describe("温度单位"),
    }),
  }
);

// 第二个工具：计算数学表达式。
const calculate = tool(
  async ({ expression }) => {
    // 演示用，真实项目请用安全的表达式求值器。
    return String(Function(`"use strict"; return (${expression})`)());
  },
  {
    name: "calculate",
    description: "计算一个数学表达式。涉及数学运算时使用。",
    schema: z.object({
      expression: z.string().describe("数学表达式，如 '2 + 3 * 4'"),
    }),
  }
);

// 先单独测一下工具能直接 invoke（不经过模型）。
const direct = await getWeather.invoke({ city: "北京", unit: "celsius" });
console.log("直接调用工具:", direct);

// tools 数组直接交给 createAgent，不要自己 .bindTools()。
const agent = createAgent({
  model: makeModel(),
  tools: [getWeather, calculate],
  systemPrompt: "你是一个简洁的助手。涉及天气和数学运算时必须调对应工具，不要凭记忆回答。",
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "北京今天多少度？" }],
});

console.log("Agent 回答:", result.messages.at(-1)?.text);
