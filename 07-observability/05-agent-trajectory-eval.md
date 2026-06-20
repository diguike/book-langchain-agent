---
title: Agent 轨迹评估
feishu_url: ""
last_synced: ""
---

> 模块 07 - 可观测性与评估 | 前置知识：[评估方法与指标](./03-evaluation.md)、[LangSmith Tracing](./02-langsmith-tracing.md)

## 答案对了，不代表 Agent 对了

[评估方法与指标](./03-evaluation.md) 讲的是评"最终答案"——给定输入，输出对不对。这对问答、RAG 够用，但对 Agent 不够。

举个我踩过的例子：一个客服 Agent，用户问"我上周买的耳机什么时候到"。Agent 最终回复"预计明天送达"，答案是对的。但翻 trace 一看，它先调了 `query_order`、又调了 `initiate_refund`（把退款工具也调了一遍！）、再调 `query_logistics` 才得出结论。最终答案蒙对了，**执行路径是错的**——多调的那个退款工具在真实环境会出事。

评 Agent 要评**轨迹**（trajectory）：它调了哪些工具、按什么顺序、参数对不对。这和评最终答案是两回事。LangChain 的 `agentevals` 包专门干这个。

## agentevals：JS 也有了

先澄清一个过时认知：很多 2025 年的资料说"`agentevals` 只有 Python，JS 用户只能自己手写 LangSmith 评估器"。到 2026 年这已经不成立——JS 版 `agentevals` 已发布，功能对齐 Python 版。

```bash
npm install agentevals @langchain/core
```

它给两条评估路径：**规则匹配**（确定性、零成本、不调模型）和 **LLM 评判**（灵活、能评没有标准答案的轨迹）。

> 一个诚实的提醒：`agentevals` 写作时还是 `0.0.x` 版本，属早期阶段，导出 API 可能小幅变动。下面的用法以当前版本为准，升级时留意 changelog。

## 路径一：规则匹配（不调模型）

如果你有"标准轨迹"（这个任务就该调这几个工具），用 `createTrajectoryMatchEvaluator` 做确定性比对，不花一分钱 token：

```typescript
// trajectory-match.ts
import { createTrajectoryMatchEvaluator } from "agentevals";

const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "strict", // 顺序和内容都要一致
  toolArgsMatchMode: "exact", // 工具参数严格相等（默认）
});

// 实际轨迹 vs 参考轨迹（都是消息数组）
const result = await evaluator({
  outputs: actualMessages, // Agent 实际跑出来的 BaseMessage[] / OpenAI 风格消息
  referenceOutputs: expectedMessages, // 期望的标准轨迹
});

console.log(result);
// { key: "trajectory_strict_match", score: true/false, comment?: "..." }
// （key 随模式而定：strict → trajectory_strict_match，unordered → trajectory_unordered_match）
```

四种匹配模式，按严格程度递减：

| 模式 | 含义 | 适用 |
|------|------|------|
| `strict` | 工具调用的顺序和内容都要一致 | 流程固定的任务（如审批流） |
| `unordered` | 工具集合一致，顺序不限 | 顺序无所谓，调对工具就行 |
| `subset` | 实际是参考的子集即通过 | 允许少调（提前结束） |
| `superset` | 实际是参考的超集即通过 | 允许多调（额外探索） |

前面那个"多调了退款工具"的 bug，用 `strict` 或 `unordered` 一跑就能逮到——实际轨迹里多了个 `initiate_refund`，对不上参考。

参数匹配可以放宽。有些工具参数不必字符级相等（城市名大小写、空格），用 `toolArgsMatchOverrides` 给特定工具自定义比对：

```typescript
const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "unordered",
  toolArgsMatchOverrides: {
    get_weather: (out, ref) =>
      (out.city ?? "").toLowerCase() === (ref.city ?? "").toLowerCase(),
  },
});
```

## 路径二：LLM 评判（没有标准轨迹也能评）

规则匹配的前提是你有标准轨迹。但很多场景没有——开放式任务的"好路径"不止一条。这时用 `createTrajectoryLLMAsJudge`，让一个模型来判断这条轨迹是否合理：

```typescript
// trajectory-judge.ts
import {
  createTrajectoryLLMAsJudge,
  TRAJECTORY_ACCURACY_PROMPT,
} from "agentevals";

const judge = createTrajectoryLLMAsJudge({
  prompt: TRAJECTORY_ACCURACY_PROMPT, // 无参考轨迹版；有标准答案用 ..._WITH_REFERENCE
  model: "openai:gpt-4o", // 评判模型，用 LangChain 模型标识
  // continuous: true → score 是 0~1 浮点；默认 false → 布尔
});

const result = await judge({
  outputs: actualMessages, // 不传 referenceOutputs 也能评
});

console.log(result);
// { key: "trajectory_accuracy", score: true, comment: "Agent 调用工具的顺序合理，没有冗余操作……" }
```

LLM 评判读完整条轨迹，判断"工具选得对不对、顺序合不合理、有没有冗余或缺失的步骤"，还会在 `comment` 里给理由。它比规则匹配灵活，但要花 token，且结果有模型的主观性——把它当"自动化的人审"，不是绝对真理。

什么时候用哪个：**有明确标准流程 → 规则匹配**（快、免费、确定）；**开放任务、好路径多样 → LLM 评判**（灵活，但有成本）。两者可以叠加：规则匹配卡硬性流程，LLM 评判补主观合理性。

## 接进 CI 和 LangSmith

轨迹评估的价值在于持续跑——每次改 prompt、换模型、加工具，都用一组固定测试轨迹回归一遍，防止"改好了一个场景，弄坏了三个"。

`agentevals` 的 evaluator 可以直接喂给 LangSmith 的 `evaluate()`，对着一个数据集批量跑（数据集和 `evaluate` 的用法见 [评估方法与指标](./03-evaluation.md)）：

```typescript
import { evaluate } from "langsmith/evaluation";

await evaluate(
  async (input) => runMyAgent(input), // 你的 Agent
  {
    data: "agent-trajectory-dataset", // LangSmith 上的数据集
    evaluators: [
      createTrajectoryLLMAsJudge({ prompt: TRAJECTORY_ACCURACY_PROMPT, model: "openai:gpt-4o" }),
    ],
  }
);
```

也能在 Vitest / Jest 里把 evaluator 当断言用，把轨迹回归直接放进单元测试。配合 [LangSmith Tracing](./02-langsmith-tracing.md)，线上跑出来的真实轨迹也能采样回来当评估集——线上发现的问题路径，变成下一轮回归用例。

## 小结

Agent 评估不能只看最终答案，要看**轨迹**——调了哪些工具、什么顺序、参数对不对。`agentevals`（JS 版已可用，注意还是早期 `0.0.x`）给两条路径：`createTrajectoryMatchEvaluator` 做确定性规则匹配（strict / unordered / subset / superset 四种模式，零成本），`createTrajectoryLLMAsJudge` 做 LLM 评判（无标准轨迹也能评，但花 token）。两者都能接进 LangSmith `evaluate()` 和 CI，把轨迹回归变成持续防线。前面那种"答案蒙对、路径出错"的隐患，只有轨迹评估能逮住。

可观测性与评估到这里就齐了：从 Tracing 看清执行、到答案评估、再到轨迹评估逮住"答案蒙对、路径出错"的隐患。下一步进入 [下一模块 生产部署](../08-production/01-api-server.md)，把验证过的 Agent 真正搬上线。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
