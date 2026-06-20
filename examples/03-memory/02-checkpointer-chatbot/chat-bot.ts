// 配套示例：03-memory/02-buffer-memory.md
// 短期记忆：给 createAgent 配一个 checkpointer，同一个 thread_id 自动续上历史。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

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

const agent = createAgent({
  model: makeModel(),
  tools: [],
  systemPrompt: "你是一个简洁的中文助手，会记住用户提过的信息。回答尽量短。",
  // MemorySaver：进程内存里的 checkpointer，开发 / 测试用。生产换 SqliteSaver / PostgresSaver。
  checkpointer: new MemorySaver(),
});

// 同一个 thread_id 代表同一段会话。框架自动按它存取完整消息历史。
const config = { configurable: { thread_id: "demo-thread-1" } };

// 第一轮：告诉它我的名字和年龄。
const first = await agent.invoke(
  { messages: [{ role: "user", content: "我叫张三，今年 28 岁。" }] },
  config
);
console.log("第 1 轮 AI:", first.messages.at(-1)?.text);

// 第二轮：只传新的一条消息，不带任何历史。
// checkpointer 会把同一 thread_id 之前的消息自动加载回来。
const second = await agent.invoke(
  { messages: [{ role: "user", content: "我多大了？我叫什么？" }] },
  config
);
console.log("第 2 轮 AI:", second.messages.at(-1)?.text);

// 第二轮的返回结果里已经带上了完整历史——第一轮的两条消息也在。
// 条数 > 2 就证明 checkpointer 确实把上一轮的历史续了回来。
console.log("第 2 轮返回的消息条数:", second.messages.length);
