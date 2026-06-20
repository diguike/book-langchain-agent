// 配套示例：07-observability/05-agent-trajectory-eval.md
// 用 agentevals 的 createTrajectoryMatchEvaluator 对 Agent 轨迹做"规则匹配"。
// 规则匹配是纯离线的——不调任何模型，零 token 成本，确定性结果。
//
// 跑法：npm install && npm start（不需要 Mock LLM，本示例完全离线）。
import { createTrajectoryMatchEvaluator } from "agentevals";

// 参考轨迹：这个客服任务"应该"调的工具序列——查订单 → 查物流，仅此两步。
// 消息用 OpenAI 风格表示：assistant 带 tool_calls，tool 带返回结果。
const referenceTrajectory = [
  { role: "user", content: "我上周买的耳机什么时候到？" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        function: { name: "query_order", arguments: JSON.stringify({ item: "耳机" }) },
      },
    ],
  },
  { role: "tool", content: "订单 O123，已发货", tool_call_id: "call_1" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_2",
        function: { name: "query_logistics", arguments: JSON.stringify({ orderId: "O123" }) },
      },
    ],
  },
  { role: "tool", content: "预计明天送达", tool_call_id: "call_2" },
  { role: "assistant", content: "您的耳机预计明天送达。" },
];

// 有问题的实际轨迹：中间多调了一次 initiate_refund（不该出现的退款工具）。
// 最终答案蒙对了，但执行路径是错的——轨迹评估就是要逮住这种隐患。
const buggyTrajectory = [
  { role: "user", content: "我上周买的耳机什么时候到？" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        function: { name: "query_order", arguments: JSON.stringify({ item: "耳机" }) },
      },
    ],
  },
  { role: "tool", content: "订单 O123，已发货", tool_call_id: "call_1" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_x",
        function: { name: "initiate_refund", arguments: JSON.stringify({ orderId: "O123" }) },
      },
    ],
  },
  { role: "tool", content: "退款流程已发起", tool_call_id: "call_x" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_2",
        function: { name: "query_logistics", arguments: JSON.stringify({ orderId: "O123" }) },
      },
    ],
  },
  { role: "tool", content: "预计明天送达", tool_call_id: "call_2" },
  { role: "assistant", content: "您的耳机预计明天送达。" },
];

// 一条"正确但工具顺序被打乱"的轨迹：先查物流后查订单，工具集合和参考一致。
const reorderedTrajectory = [
  { role: "user", content: "我上周买的耳机什么时候到？" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_2",
        function: { name: "query_logistics", arguments: JSON.stringify({ orderId: "O123" }) },
      },
    ],
  },
  { role: "tool", content: "预计明天送达", tool_call_id: "call_2" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        function: { name: "query_order", arguments: JSON.stringify({ item: "耳机" }) },
      },
    ],
  },
  { role: "tool", content: "订单 O123，已发货", tool_call_id: "call_1" },
  { role: "assistant", content: "您的耳机预计明天送达。" },
];

// strict：顺序和内容都要一致。
const strictEval = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "strict",
});

// unordered：工具集合一致即可，顺序不限。
const unorderedEval = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "unordered",
});

async function main() {
  console.log("=== strict 模式：参考轨迹 vs 自身（应通过）===");
  const r1 = await strictEval({
    outputs: referenceTrajectory as never,
    referenceOutputs: referenceTrajectory as never,
  });
  console.log(r1);

  console.log("\n=== strict 模式：多调了 initiate_refund 的轨迹（应失败）===");
  const r2 = await strictEval({
    outputs: buggyTrajectory as never,
    referenceOutputs: referenceTrajectory as never,
  });
  console.log(r2);

  console.log("\n=== strict 模式：工具顺序被打乱（应失败，strict 在意顺序）===");
  const r3 = await strictEval({
    outputs: reorderedTrajectory as never,
    referenceOutputs: referenceTrajectory as never,
  });
  console.log(r3);

  console.log("\n=== unordered 模式：同一条乱序轨迹（应通过，集合一致）===");
  const r4 = await unorderedEval({
    outputs: reorderedTrajectory as never,
    referenceOutputs: referenceTrajectory as never,
  });
  console.log(r4);

  console.log("\n=== unordered 模式：多调退款的轨迹（仍应失败，集合多了一个工具）===");
  const r5 = await unorderedEval({
    outputs: buggyTrajectory as never,
    referenceOutputs: referenceTrajectory as never,
  });
  console.log(r5);
}

main();
