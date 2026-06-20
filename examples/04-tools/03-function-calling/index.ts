// 配套示例：04-tools/03-function-calling.md
// Function Calling：同一套 tool 交给 createAgent，由模型自己决定调哪个工具。
// 另外演示单步观察——直接 invoke 模型 + tool_choice "any" 看它选了哪个工具（仅调试用）。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
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

// 定义一次，跨厂商通用。
const getWeather = tool(
  async ({ city }) => {
    return JSON.stringify({ city, temperature: 22, condition: "晴" });
  },
  {
    name: "get_weather",
    description: "获取指定城市的实时天气。涉及天气时使用。",
    schema: z.object({
      city: z.string().describe("城市名"),
    }),
  }
);

const calculate = tool(
  async ({ expression }) => {
    return String(Function(`"use strict"; return (${expression})`)());
  },
  {
    name: "calculate",
    description: "计算数学表达式。涉及数学运算时使用。",
    schema: z.object({
      expression: z.string().describe("数学表达式，如 '2 + 3 * 4'"),
    }),
  }
);

const tools = [getWeather, calculate];

// —— 路径一：让模型自己决定调哪个工具（createAgent 跑完整 model ↔ tools 循环）——
const agent = createAgent({
  model: makeModel(),
  tools,
  systemPrompt: "你是一个高效的助手。涉及天气或数学运算时必须调对应工具，不要凭记忆回答。回答简洁。",
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "北京今天天气怎么样？" }],
});
console.log("Agent 回答:", result.messages.at(-1)?.text);

// —— 路径二：单步观察模型选了哪个工具（仅调试用，生产请用 createAgent）——
// tool_choice "any" 是 LangChain 统一值（对应 OpenAI 原生的 "required"），强制至少调一个工具。
const model = makeModel();
const response = await model.invoke([new HumanMessage("帮我算一下 2 + 3 * 4")], {
  tools,
  tool_choice: "any",
});

if (response.tool_calls && response.tool_calls.length > 0) {
  for (const tc of response.tool_calls) {
    // args 已经是解析好的对象，不是 JSON 字符串——跨厂商差异被抽象层抹平了。
    console.log(`单步观察 -> 工具: ${tc.name}, 参数: ${JSON.stringify(tc.args)}`);
  }
} else {
  console.log("单步观察 -> 模型未选择任何工具");
}
