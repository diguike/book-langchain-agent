// 配套示例：01-core-abstractions/05-output-parsers.md
// 新闻分析器：用 withStructuredOutput(schema, { method: "functionCalling" }) 从一段
// 新闻文本提取结构化的分析结果（分类 / 要点 / 实体 / 情感 / 预估阅读时间）。
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
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

// 1. 定义 schema：字段名用英文，describe 用中文说清含义
const articleAnalysisSchema = z.object({
  title: z.string().describe("文章标题"),
  category: z
    .enum(["technology", "business", "science", "politics", "sports", "other"])
    .describe("文章分类"),
  keyPoints: z.array(z.string()).min(1).max(5).describe("核心要点，1-5 条"),
  entities: z
    .array(
      z.object({
        name: z.string().describe("实体名称"),
        type: z
          .enum(["person", "organization", "location", "product"])
          .describe("实体类型"),
      })
    )
    .describe("提到的关键实体"),
  sentiment: z
    .enum(["positive", "negative", "neutral"])
    .describe("文章整体基调"),
  readingTimeMinutes: z.number().describe("预估阅读时间（分钟）"),
});

type ArticleAnalysis = z.infer<typeof articleAnalysisSchema>;

// 2. 构建链：withStructuredOutput 走 function calling，强制按 schema 输出
const model = makeModel();
const structuredModel = model.withStructuredOutput(articleAnalysisSchema, {
  method: "functionCalling",
  includeRaw: false,
});

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "你是新闻分析助手，请仔细阅读文章并提取结构化信息。"],
  ["human", "请分析以下文章：\n\n{article}"],
]);

const analysisChain = prompt.pipe(structuredModel);

// 3. 调用
const analysis: ArticleAnalysis = await analysisChain.invoke({
  article: `
    苹果公司今日在加州库比蒂诺总部举行发布会，正式推出搭载 M4 芯片的
    新一代 MacBook Pro。CEO 蒂姆·库克表示，新款笔记本在 AI 推理性能上
    相比上一代提升了 3 倍。新品起售价 1599 美元，将于下周五正式发售。
    分析师认为这将进一步巩固苹果在高端笔记本市场的领先地位。
  `,
});

console.log(JSON.stringify(analysis, null, 2));
