// 配套示例：05-agent-architecture/01-create-agent.md
// 一个最小 Agent：能查天气、能算数。
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

const getWeather = tool(
  async ({ city }) => {
    // 真实场景这里调外部 API
    return `${city} 今天 22°C，多云`;
  },
  {
    name: "get_weather",
    description: "查询某个城市的实时天气",
    schema: z.object({ city: z.string().describe("城市名，如 '北京'") }),
  }
);

const calculator = tool(
  async ({ expression }) => {
    // 实际项目请用安全的表达式求值器，这里仅做示例
    return String(eval(expression));
  },
  {
    name: "calculator",
    description: "计算一个数学表达式",
    schema: z.object({ expression: z.string().describe("如 '3 * (4 + 5)'") }),
  }
);

const agent = createAgent({
  model: makeModel(),
  tools: [getWeather, calculator],
  systemPrompt: "你是一个简洁的助手，能查天气和算数。回答要短。",
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "北京今天多少度？" }],
});

console.log(result.messages.at(-1)?.text);
