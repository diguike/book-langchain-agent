---
title: Prompt 工程优化
feishu_url: ""
last_synced: ""
---

> 模块 07 - 可观测性与评估 | 前置知识：[评估方法与指标](./evaluation.md)、[LangSmith Tracing](./langsmith-tracing.md)

## 把 prompt 当代码版本管理

我见过太多团队 prompt 优化的方式是这样的：产品经理拍一句 prompt，工程师粘进代码，跑一下手感"好像更准了"，提交。三周后线上回归一个老 case，发现这次改动让某类输入变差了，但已经没人记得为什么改、改之前长什么样、当时为什么觉得变好了。

Prompt 优化应该跟代码改动一样有评审、有评估、有版本号。这一节不讲 prompt engineering 的"技巧大杂烩"，只讲三件事：

1. **方法论**：从 few-shot → chain-of-thought（CoT）→ 结构化输出 的渐进策略
2. **系统化迭代**：用 LangSmith Playground 对比 prompt 版本，用 evaluator 量化效果
3. **版本管理**：本地代码管理 + LangSmith Hub 远程托管

技巧本身是手段，能用数据证明哪个 prompt 更好才是关键。

## 三段式起手：清晰、约束、结构化

写好一个 prompt 的基本盘是这三件事，不做完这三件事之前别上各种花活儿。

### 1. 清晰：明确告诉模型要做什么

```typescript
// 模糊：模型自己脑补
const vague = "帮我处理这些数据";

// 清晰：每个细节都讲死
const clear = `将以下 CSV 数据转换为 JSON 数组。
- 每行代表一个用户，字段：name, age, email
- 跳过空行和以 # 开头的注释行
- 输出格式：[{"name": "张三", "age": 25, "email": "zhang@example.com"}]
- 若某字段缺失，对应 JSON 属性输出 null`;
```

### 2. 约束：明确格式、长度、语气

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";

const constrained = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是技术文档助手。

规则：
- 用中文回答，技术术语保留英文（如 React, useState）
- 单次回答不超过 300 字
- 输出 Markdown 格式
- 代码示例用 TypeScript
- 不确定的内容标 "（待确认）"`,
  ],
  ["user", "{question}"],
]);
```

### 3. 结构化：用分隔符 / XML 标签划分 prompt 各部分

模型对边界标记敏感。XML 标签比纯文本分段更稳定，Claude 系列尤其吃这一套：

```typescript
const structured = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是代码审查助手。

<task>
审查用户提交的代码，找出问题并给出改进建议。
</task>

<output_format>
## 问题列表
1. [严重程度: 高/中/低] 简述问题
   - 位置：第 X 行
   - 建议：具体修改方案（贴改后的代码）

## 总结
1-2 句话给出总体评价
</output_format>

<rules>
- 只关注代码质量（命名、复杂度、错误处理、安全），不点评业务逻辑
- 严重程度排序：安全 > 性能 > 可维护性
- 每个问题必须附带改进后的代码
</rules>`,
  ],
  ["user", "请审查以下代码：\n\n```typescript\n{code}\n```"],
]);
```

这三件事做扎实，大部分场景已经够用。下面的"高级技巧"只是在这个基础上加 buff。

## Few-Shot：用例子教模型

模型对你给的格式示例非常敏感。让它输出 JSON、做情感分析这种格式重的任务，给 3-5 个例子比写一堆描述有效。

```typescript
import { ChatPromptTemplate } from "@langchain/core/prompts";

const fewShot = ChatPromptTemplate.fromMessages([
  ["system", "你是情感分析专家。分析用户评价，输出 JSON 格式。"],
  // 示例 1
  ["user", "这个产品太差了，完全不值这个价"],
  ["assistant", `{"sentiment": "negative", "aspect": "性价比", "intensity": 0.9}`],
  // 示例 2
  ["user", "包装精美，送货也快"],
  ["assistant", `{"sentiment": "positive", "aspect": "物流", "intensity": 0.7}`],
  // 示例 3
  ["user", "功能还行，就是界面有点丑"],
  ["assistant", `{"sentiment": "mixed", "aspect": "用户体验", "intensity": 0.5}`],
  // 真实输入
  ["user", "{input}"],
]);
```

几个实战技巧：

- **覆盖边界 case**：示例里要包含 positive / negative / mixed / 模糊语义 各一条，让模型见过所有可能的输出
- **不要给完全一样的示例**：3 条都是"产品差"的负面例子，模型会以为你只关心负面
- **难例放后面**：模型对最后一个示例的格式记得最清楚，把最关键的格式约束放最后

如果有上千个候选示例，可以做动态选择——按当前输入的语义相似度挑最相关的 k 个：

```typescript
import { SemanticSimilarityExampleSelector } from "@langchain/core/example_selectors";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";

const allExamples = [
  { input: "...", output: "..." },
  // ... 几百条
];

const selector = await SemanticSimilarityExampleSelector.fromExamples(
  allExamples,
  new OpenAIEmbeddings(),
  MemoryVectorStore,
  { k: 3 }
);

const selected = await selector.selectExamples({ input: "用户的当前输入" });
// 拿到最相似的 3 个示例后拼到 prompt 里
```

## Chain-of-Thought：让模型先思考

对于复杂推理任务（数学、代码审查、多跳问答），让模型显式输出思考过程能显著提升正确率。最简单的写法就是在 system prompt 里加一句"先思考再回答"：

```typescript
const cot = ChatPromptTemplate.fromMessages([
  [
    "system",
    `你是数学推理助手。解题流程：
1. 理解：明确已知条件和求解目标
2. 计划：选定解题思路
3. 执行：分步骤计算，每步给出公式和结果
4. 验证：检查答案合理性
5. 结论：给出最终答案

请严格按这五步输出。`,
  ],
  ["user", "{question}"],
]);
```

更可靠的做法是把推理过程做成结构化输出，避免模型偷懒跳步：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";

const ReasoningOutput = z.object({
  understanding: z.string().describe("题意理解"),
  steps: z.array(z.object({
    n: z.number(),
    operation: z.string().describe("这一步做什么"),
    result: z.string().describe("这一步的输出"),
  })),
  verification: z.string().describe("验证过程"),
  finalAnswer: z.string(),
  confidence: z.number().min(0).max(1),
});

const model = new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 })
  .withStructuredOutput(ReasoningOutput);

const out = await model.invoke(
  "一辆车以 60 km/h 行驶 2.5 小时，又以 80 km/h 行驶 1 小时，总路程多少？"
);

console.log(out.steps);
// [
//   { n: 1, operation: "第一段路程 = 60 × 2.5", result: "150 km" },
//   { n: 2, operation: "第二段路程 = 80 × 1", result: "80 km" },
//   { n: 3, operation: "总路程 = 150 + 80", result: "230 km" },
// ]
console.log(out.finalAnswer); // "230 km"
```

**Claude 系列还有原生的 thinking mode**——在 `ChatAnthropic` 上传 `thinkingBudget` 让模型用内部 thinking blocks 推理，输出不会包含思考过程但精度提升明显（适合不想暴露思考过程给用户的场景）：

```typescript
const model = new ChatAnthropic({
  model: "claude-opus-4-7",
  thinkingBudget: 10000, // tokens
});
```

## Self-Consistency：多次采样投票

对正确性要求极高的任务（金融、医疗、法务），单次推理可能错，多次采样取众数能拉一截。代价是 token 翻 k 倍：

```typescript
import { ChatOpenAI } from "@langchain/openai";

async function selfConsistency(question: string, k = 5): Promise<string> {
  // 用一定 temperature 产生不同推理路径
  const model = new ChatOpenAI({ model: "gpt-5", temperature: 0.7 });

  const samples = await Promise.all(
    Array.from({ length: k }, () => model.invoke(question))
  );
  const answers = samples.map((s) => s.content as string);

  // 用一个 temperature=0 的 judge 聚合
  const aggregator = new ChatOpenAI({ model: "gpt-5", temperature: 0 });
  const agg = await aggregator.invoke([
    {
      role: "system",
      content: `下面是 ${k} 个对同一问题的独立回答。给出最一致的结论作为最终答案。
若多个回答互相矛盾，选多数派；若分歧严重，明确指出"低置信度"并解释。`,
    },
    {
      role: "user",
      content: `问题：${question}\n\n回答：\n${answers
        .map((a, i) => `[${i + 1}] ${a}`)
        .join("\n\n")}`,
    },
  ]);
  return agg.content as string;
}
```

我不在常规场景用这个——成本是 k+1 倍。只在做关键决策（比如医保理赔判定）时用，且会用更便宜的模型采样、用强模型聚合。

## 用 LangSmith Playground 对比 prompt 版本

写到这里所有"技巧"都是手段，关键问题是怎么知道某个改动有没有效果。

LangSmith Playground 是我做 prompt 调优的主战场。它直接连到你的 LangSmith 项目，可以：

1. **从 trace 一键打开 Playground**：选某条线上 trace，"Open in Playground"，prompt + 输入直接载入
2. **改 prompt 重新跑**：编辑 system prompt 或 user message，点 Run，立刻看新输出
3. **多版本并排对比**：开多个 Playground tab，同一个输入跑不同 prompt
4. **保存为 Hub Prompt**：满意的版本一键保存到 LangSmith Hub，带版本号

工作流：

1. 从生产 trace 找到坏 case（比如 correctness 评分 < 0.5 的那条）
2. 在 Playground 里加载，确认能复现
3. 改 prompt（加一条规则 / 加一个 few-shot 示例）
4. 跑一遍，看是否修复
5. 用同一组改动跑 dataset evaluator（[评估方法与指标](./evaluation.md) 那一套），看是否引入回归
6. 通过则发版

第 5 步是关键。Playground 改完看着好，但跑一遍 dataset 才能确认其他 case 没退化。

## LangSmith Hub：远程 prompt 仓库

LangSmith Hub 把 prompt 当 Git 仓库管。每次推送都有版本号，commit message，可以 rollback。

```typescript
import * as hub from "langchain/hub";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatAnthropic } from "@langchain/anthropic";

// 推 prompt 到 Hub
const newPrompt = ChatPromptTemplate.fromMessages([
  ["system", "你是客服助手，遵循以下规则：..."],
  ["user", "{question}"],
]);

await hub.push("my-org/customer-service", newPrompt, {
  newRepoIsPublic: false, // 私有仓库
});

// 从 Hub 拉
const prompt = await hub.pull<ChatPromptTemplate>("my-org/customer-service");
const model = new ChatAnthropic({ model: "claude-sonnet-4-6" });
const chain = prompt.pipe(model);
const result = await chain.invoke({ question: "怎么退货？" });

// 拉指定版本（commit hash）
const v2 = await hub.pull<ChatPromptTemplate>("my-org/customer-service:1a2b3c4d");
```

Hub 的杀手锏是**生产 prompt 跟代码解耦**。运营或产品改 prompt 不用 PR、不用部署，在 LangSmith UI 上改完直接推新版本，代码里通过 `hub.pull` 拿到最新版本（建议配 cache 避免每次都拉网）。回滚也快——指定一个老版本号即可。

风险点：

- **prompt 改动也要跑 evaluator**：不要因为"只是改了句话"就跳过回归
- **生产指定版本号而不是 latest**：避免运营误推坏 prompt 直接打到生产

## 本地版本管理：纯代码也能做

不用 Hub 的话，纯代码也能版本化：

```typescript
// src/prompts/customer-service.ts
import { ChatPromptTemplate } from "@langchain/core/prompts";

export const VERSIONS = {
  v1: ChatPromptTemplate.fromMessages([
    ["system", "你是客服助手。"],
    ["user", "{question}"],
  ]),

  v2: ChatPromptTemplate.fromMessages([
    [
      "system",
      `你是专业客服助手。
规则：
- 先确认问题类别
- 给出具体解决方案
- 主动追问澄清`,
    ],
    ["user", "{question}"],
  ]),

  v3: ChatPromptTemplate.fromMessages([
    [
      "system",
      `你是专业客服助手。

<guidelines>
1. 先表达理解和同理心
2. 准确识别问题类别（退换货 / 配送 / 支付 / 其他）
3. 提供步骤化解决方案
4. 确认问题是否解决
</guidelines>

<tone>
专业但友好；用"您"称呼用户；避免技术术语堆砌。
</tone>`,
    ],
    ["user", "{question}"],
  ]),
} as const;

const ACTIVE = (process.env.PROMPT_VERSION ?? "v3") as keyof typeof VERSIONS;
export const activePrompt = VERSIONS[ACTIVE];
```

环境变量切换版本，便于灰度。但缺点是改 prompt 要走代码发版，不如 Hub 灵活。

## 一个完整的 prompt 优化迭代

把前面所有东西串起来。假设我要把客服 Agent 的 correctness 从 0.72 提升到 0.85，工作流是这样的：

```typescript
// src/eval/prompt-iterate.ts
import "dotenv/config";
import { evaluate } from "langsmith/evaluation";
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { correctnessJudge, harmfulnessJudge } from "./judges";

// 定义候选 prompt 变体
const variants = [
  {
    name: "v1-baseline",
    systemPrompt: "你是客服助手，回答用户问题。",
  },
  {
    name: "v2-structured",
    systemPrompt: `你是专业客服助手。

<rules>
1. 先确认问题类别
2. 给出具体解决方案
3. 询问是否需要进一步帮助
</rules>`,
  },
  {
    name: "v3-cot",
    systemPrompt: `你是专业客服助手。

回答前先思考：
1. 用户的核心诉求是什么？
2. 属于哪一类问题（退换货 / 配送 / 支付 / 其他）？
3. 标准化解决方案是什么？

然后输出回答，结构清晰，不要把思考过程暴露给用户。`,
  },
  {
    name: "v4-cot-fewshot",
    systemPrompt: `你是专业客服助手。

回答前先思考问题类别和方案。然后用以下格式回答：

格式示例：
用户问"怎么退货" → 回答"您好，退货流程如下：1. 登录账户 → 订单详情；2. 点击申请退货；3. 选择原因并提交；4. 等待客服审核。审核通过后会收到退货地址。还有其他问题吗？"

格式示例：
用户问"我的快递怎么还没到" → 回答"很抱歉给您带来不便。请告诉我您的订单号，我帮您查询物流。也可以直接登录账户在订单详情查看实时物流。"

按这个风格回答用户。`,
  },
];

function buildTarget(systemPrompt: string) {
  const agent = createAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
    tools: [],
    systemPrompt,
  });
  return async (input: { question: string }) => {
    const result = await agent.invoke({
      messages: [{ role: "user", content: input.question }],
    });
    return { answer: result.messages.at(-1)?.content as string };
  };
}

for (const v of variants) {
  console.log(`运行实验：${v.name}`);
  await evaluate(buildTarget(v.systemPrompt), {
    data: "customer-service-regression",
    evaluators: [correctnessJudge, harmfulnessJudge],
    experimentPrefix: v.name,
    maxConcurrency: 3,
  });
}

console.log("所有实验完成，到 LangSmith Compare 视图对比");
```

跑完到 LangSmith → Datasets → customer-service-regression → Experiments，把这四个实验勾上点 Compare，能看到每个 example 在四个版本下的输出和评分。一眼能看出：哪个版本整体最好、哪些 case 在 v3 修了但 v4 又坏了、哪一类问题所有版本都答不对（需要补 few-shot 或换模型）。

## 注意事项

- **每次改 prompt 都跑回归**：除非只改 typo
- **关注尾部表现**：平均分上去了不代表没坑，看 P10、P5 那批 case
- **prompt 跟模型耦合**：同一个 prompt 在 Claude / GPT / Gemini 上表现差别大，换模型要重新评估
- **temperature 是另一个调参轴**：correctness 评估时模型一律 temperature=0，避免随机性污染评分
- **token 成本要算**：v4 比 v1 多塞 200 token，乘以 QPS 是真金白银，要权衡

## 小结

Prompt 工程的核心不在技巧而在工作流：写清晰约束的基础 prompt → 加 few-shot / CoT / 结构化输出 buff → 在 LangSmith Playground 对比版本 → 用 evaluator 量化效果 → 用 Hub 或代码版本化管理。每个改动都要数据证明，从"感觉变好了"升级到"correctness 从 0.72 升到 0.85，harmfulness 不退化"。

模块 07 到这里告一段落。下一模块 [08 生产部署](../08-production/api-server.md) 开始把 Agent 包成 API 服务、加流式、加缓存、加安全、推上线。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
