// 配套示例：02-chain-composition/04-streaming.md
// 流式输出：用 chain.stream() 逐 token 打印（打字机效果），
// 再用 streamEvents({ version: "v2" }) 拿链里每个节点的事件。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";

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

const prompt = ChatPromptTemplate.fromTemplate("用一句话介绍 {concept}");
const model = makeModel();
const parser = new StringOutputParser();

// 全链流式：ChatModel + StringOutputParser，chunk 类型是 string
const chain = prompt.pipe(model).pipe(parser);

// ============ Part 1：.stream() 逐 token 打印 ============
console.log("== .stream() 打字机输出 ==");
const stream = await chain.stream({ concept: "量子计算" });
for await (const chunk of stream) {
  process.stdout.write(chunk); // 逐 token 输出
}
console.log("\n");

// ============ Part 2：.streamEvents() 拿链里每个节点的事件 ============
console.log("== .streamEvents({ version: \"v2\" }) 事件流 ==");
const eventStream = chain.streamEvents(
  { concept: "量子纠缠" },
  { version: "v2" } // v2 是当前稳定版本，必填
);

for await (const event of eventStream) {
  switch (event.event) {
    case "on_chat_model_stream": {
      // 模型吐出的每个 token：用 contentBlocks 拿统一格式的文本
      const chunk = event.data.chunk;
      const text =
        chunk?.contentBlocks
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text?: string }) => b.text ?? "")
          .join("") ?? "";
      process.stdout.write(text);
      break;
    }
    case "on_chain_start":
      console.log(`\n[chain start] ${event.name}`);
      break;
    case "on_chain_end":
      console.log(`\n[chain end]   ${event.name}`);
      break;
  }
}
console.log();
