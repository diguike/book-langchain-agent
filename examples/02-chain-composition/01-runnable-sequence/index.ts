// 配套示例：02-chain-composition/01-runnable-sequence.md
// LCEL 串联：prompt | model | parser，外加一个后处理步骤的四步流水线。
// 演示一条产品评论分析链：结构化输出 + 把 rating 渲染成星星。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { z } from "zod";

// 没设 OPENAI_API_KEY 时，自动指向本地 Mock LLM Server（examples/_shared/mock-llm）。
function makeModel(temperature = 0) {
  return new ChatOpenAI({
    model: "mock-claude",
    apiKey: process.env.OPENAI_API_KEY ?? "mock-key",
    temperature,
    configuration: process.env.OPENAI_API_KEY
      ? undefined
      : { baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1" },
  });
}

// ============ Part 1：最小可运行链 prompt | model | parser ============

const explainPrompt = ChatPromptTemplate.fromTemplate(
  "用一句话解释什么是 {concept}"
);
const parser = new StringOutputParser();
const explainChain = explainPrompt.pipe(makeModel()).pipe(parser);

const explanation = await explainChain.invoke({ concept: "量子纠缠" });
console.log("== 一句话解释 ==");
console.log(explanation);
console.log("（类型：" + typeof explanation + "）\n");

// ============ Part 2：四步流水线（结构化输出 + 后处理） ============

// 1. 定义结构化输出 schema
const reviewSchema = z.object({
  summary: z.string().describe("一句话总结"),
  pros: z.array(z.string()).describe("优点列表"),
  cons: z.array(z.string()).describe("缺点列表"),
  rating: z.number().min(1).max(5).describe("1-5 评分"),
});

// 2. 用 withStructuredOutput 替代手写 parser（1.x 推荐显式 method: "functionCalling"）
const structuredModel = makeModel().withStructuredOutput(reviewSchema, {
  method: "functionCalling",
});

// 3. prompt
const reviewPrompt = ChatPromptTemplate.fromTemplate(`
你是一位严谨的产品评测师。请根据用户反馈对产品做结构化评测。

产品名称：{product}
用户反馈：{feedback}
`);

// 4. 后处理：把 rating 渲染成星星
function addRatingDisplay(review: z.infer<typeof reviewSchema>) {
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  return { ...review, display: `${stars} (${review.rating}/5)` };
}

// 5. 组合成 RunnableSequence
const reviewChain = RunnableSequence.from([
  reviewPrompt,
  structuredModel,
  addRatingDisplay,
]);

// 6. 执行
const result = await reviewChain.invoke({
  product: "AirPods Pro 2",
  feedback: "降噪很好，续航一般，戴久了耳朵痛",
});

console.log("== 产品评测（四步流水线） ==");
console.log(JSON.stringify(result, null, 2));
