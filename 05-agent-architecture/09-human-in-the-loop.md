---
title: Human-in-the-Loop 与 typed interrupt
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/H5QRwukvWiKJ3Yk9sRLcXPCrnph"
last_synced: "2026-05-25T02:42:27+08:00"
---

> 模块 05 - Agent 架构 | 前置知识：[createAgent 入门](./01-create-agent.md)、[LangGraph State 与 Checkpointer](./04-langgraph-state.md)

## 哪些场景必须有人

不是所有 AI 失误都能事后补救。我见过的几个真实事故：

- Agent 把"删除测试库的某张表"解析成"删除生产库的所有表"，跑了 `DROP TABLE`
- 客服 Agent 在退款流程里把退款金额读成了订单金额的 10 倍
- 邮件 Agent 把内部 RFC 草稿当成正式公告发给了全公司

这类操作的共同点：**不可逆、影响大、错误成本远大于多走一步审批**。Human-in-the-Loop（HITL）就是在这些操作的执行之前强制暂停，让人确认或修改。

LangGraph 1.x 把这件事抽象成 **typed interrupt** —— 用 TypeScript 类型描述"我要让人看什么、用人回什么"，配合 checkpointer 实现"暂停 → 持久化 → 等任意时长 → 恢复"。

## 核心原语：interrupt + Command

两个 API 配合：

| API | 作用 |
|-----|------|
| `interrupt(payload)` | 在节点内部调用，立即暂停 graph，把 `payload` 传给调用方 |
| `Command({ resume: value })` | 用户做完决定后，把 `value` 作为 `interrupt()` 的返回值喂回去 |

底层依赖 checkpointer——`interrupt` 之前的所有 state 都已经被持久化，进程可以重启、用户可以隔天回来，凭 `thread_id` 找到那个暂停点继续。

最小示例：

```typescript
import { interrupt, Command } from "@langchain/langgraph";

async function approvalNode(state: MyState) {
  // 暂停，把待审批信息抛给调用方
  const decision = interrupt({
    type: "approval_request",
    operation: "delete_database",
    target: state.targetDb,
  });

  // 用户回来之后，decision 就是 Command 里 resume 传的值
  if (decision.approved) {
    return { status: "approved" };
  }
  return { status: "rejected", reason: decision.reason };
}

// 调用端
const cfg = { configurable: { thread_id: "session-1" } };

// 第一次 invoke —— 跑到 interrupt 时暂停
const first = await app.invoke({ ... }, cfg);
// 此时可以 await app.getState(cfg) 拿到暂停信息

// 用户审批后 ——
const second = await app.invoke(
  new Command({ resume: { approved: true } }),
  cfg
);
```

## 在 createAgent 上声明 typed interrupt

`createAgent` 直接支持 `interrupts` 配置，比手写 graph 节点省好几行：

```typescript
// createAgent-with-interrupts.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { MemorySaver, Command } from "@langchain/langgraph";
import { z } from "zod";

// 工具：删数据
const deleteRows = tool(
  async ({ table, where }) => `已删除 ${table} 中 WHERE ${where} 的数据`,
  {
    name: "delete_rows",
    description: "从表中删除满足条件的行（高风险）",
    schema: z.object({
      table: z.string(),
      where: z.string(),
    }),
  }
);

// 工具：转账
const transfer = tool(
  async ({ amount, to }) => `已向 ${to} 转账 ${amount} 元`,
  {
    name: "transfer",
    description: "向指定账户转账（高风险）",
    schema: z.object({
      amount: z.number(),
      to: z.string(),
    }),
  }
);

// 工具：查询
const queryRows = tool(
  async ({ table }) => `表 ${table} 共 1234 行`,
  {
    name: "query_rows",
    description: "查询表的行数（只读）",
    schema: z.object({ table: z.string() }),
  }
);

const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [deleteRows, transfer, queryRows],
  systemPrompt: "你是数据库管理助手。",

  // typed interrupt 配置
  interrupts: {
    // 哪些工具调用前必须人审
    beforeToolCall: {
      tools: ["delete_rows", "transfer"],
      // 给前端展示的载荷类型
      payload: (toolCall) => ({
        type: "tool_approval" as const,
        toolName: toolCall.name,
        args: toolCall.args,
        riskLevel: "high" as const,
      }),
    },
  },

  // typed interrupt 必须配 checkpointer
  checkpointer: new MemorySaver(),
});
```

`interrupts.beforeToolCall.tools` 数组里列的工具会在执行前自动触发 interrupt。`payload` 函数决定抛给调用方什么数据——返回什么类型，恢复时 `Command({ resume })` 就要传对应的回应类型。

调用流程：

```typescript
const cfg = { configurable: { thread_id: "admin-session-1" } };

// 1. 用户发起请求
const r1 = await agent.invoke(
  {
    messages: [
      { role: "user", content: "把 users 表里 status='deleted' 的全删了" },
    ],
  },
  cfg
);

// 2. Agent 走到 delete_rows 工具调用前暂停，r1 里能看到 interrupt 信息
const state = await agent.getState(cfg);
console.log("暂停于:", state.next); // ["tools"]
// 如果此处返回 undefined，用 console.log(state) 检查 LangGraph 当前版本的数据结构
console.log("待审批:", state.tasks[0]?.interrupts?.[0]?.value);
// → { type: "tool_approval", toolName: "delete_rows", args: { table: "users", where: "status='deleted'" }, riskLevel: "high" }

// 3. 前端展示给运维，运维点"批准"
const r2 = await agent.invoke(
  new Command({ resume: { action: "approve" } }),
  cfg
);

// 4. Agent 继续执行 delete_rows，拿到结果回模型节点，给用户最终回复
console.log(r2.messages.at(-1)?.content);
```

resume 传的值是什么 schema，由你跟前端约好——`{ action: "approve" }`、`{ action: "reject", reason: "..." }`、`{ action: "modify", newArgs: { ... } }` 都行。

## 静态 interrupt vs 动态 interrupt

LangGraph 提供两种方式触发暂停：

| 方式 | 怎么用 | 适用场景 |
|------|--------|----------|
| 静态 | 在 `compile()` 或 `createAgent` 时声明 `interruptBefore` / `interruptAfter` | "凡是调这个工具就要审" |
| 动态 | 在节点函数里手动调 `interrupt(payload)` | "金额超过 1 万才要审" |

上面 `createAgent` 那个例子是静态的——只要工具名在 `tools` 数组里，就一定暂停。

动态的写法（手写 graph 时）：

```typescript
import { interrupt } from "@langchain/langgraph";

async function checkApprovalNode(state: OrderState) {
  const amount = state.orderDetails?.amount ?? 0;

  // 只有大额订单才暂停
  if (amount > 10000) {
    const decision = interrupt({
      type: "large_order_approval",
      amount,
      orderId: state.orderDetails?.id,
    });

    if (decision.action === "reject") {
      return { status: "rejected", reason: decision.reason };
    }
  }

  return { status: "approved" };
}
```

两种方式我都用过，**动态更灵活但更难追踪**——前端要做的状态管理更复杂。生产建议先静态，确实需要按业务条件分流时再上动态。

## 修改 Agent 决策再恢复

最复杂也最实用的场景：人审时不光"通过/拒绝"，还要**修改**模型生成的工具参数。比如 Agent 准备删 `WHERE status='deleted'`，运维看了说"不对，应该是 `status='archived'`，改完再执行"。

resume 时传修改后的参数，节点函数把它合并到工具调用里：

```typescript
async function approvalNode(state: MessagesState) {
  const lastAi = state.messages.at(-1) as AIMessage;
  const sensitiveCall = lastAi.tool_calls?.find(
    (tc) => ["delete_rows", "transfer"].includes(tc.name)
  );
  if (!sensitiveCall) return {};

  const decision = interrupt({
    type: "approval_with_edit",
    toolName: sensitiveCall.name,
    args: sensitiveCall.args,
  });

  if (decision.action === "reject") {
    // 用一条 AIMessage 替换原决策，让循环结束
    return {
      messages: [
        new AIMessage({
          id: lastAi.id, // 同 ID 触发 messagesStateReducer 的"替换"语义
          content: `操作被取消：${decision.reason ?? "用户拒绝"}`,
          tool_calls: [], // 清空工具调用
        }),
      ],
    };
  }

  if (decision.action === "modify") {
    // 用修改后的参数生成新的 AIMessage，替换原决策
    return {
      messages: [
        new AIMessage({
          id: lastAi.id,
          content: lastAi.content,
          tool_calls: lastAi.tool_calls?.map((tc) =>
            tc.id === sensitiveCall.id
              ? { ...tc, args: decision.newArgs }
              : tc
          ),
        }),
      ],
    };
  }

  // approve：什么都不改，让 tools 节点正常执行
  return {};
}
```

技巧：**用相同的 `id` 返回新 AIMessage，`messagesStateReducer` 会把旧消息替换掉**（这个行为我在 [LangGraph State](./04-langgraph-state.md) 里讲过）。比直接 mutate state 干净得多。

## 实战：高风险订单审批流

把所有概念串起来——一个完整的订单处理 Agent，大额订单走经理审批：

```typescript
// order-approval.ts
import {
  StateGraph,
  START,
  END,
  Annotation,
  MemorySaver,
  interrupt,
  Command,
} from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";

const OrderState = Annotation.Root({
  input: Annotation<string>,
  orderDetails: Annotation<{
    product: string;
    quantity: number;
    totalPrice: number;
  } | null>({
    reducer: (_, upd) => upd,
    default: () => null,
  }),
  status: Annotation<"pending" | "approved" | "rejected" | "completed">({
    reducer: (_, upd) => upd,
    default: () => "pending" as const,
  }),
  result: Annotation<string>({
    reducer: (_, upd) => upd,
    default: () => "",
  }),
});

const APPROVAL_THRESHOLD = 5000;

// 1. 解析订单
const parserModel = new ChatAnthropic({
  model: "claude-haiku-4-5",
  temperature: 0,
});

async function parseOrder(state: typeof OrderState.State) {
  // 简化：实际项目用 withStructuredOutput
  const orderDetails = {
    product: "MacBook Pro",
    quantity: 3,
    totalPrice: 15000,
  };
  return { orderDetails };
}

// 2. 经理审批（动态 interrupt）
async function managerApproval(state: typeof OrderState.State) {
  const order = state.orderDetails!;

  // 小额直接通过
  if (order.totalPrice <= APPROVAL_THRESHOLD) {
    return { status: "approved" as const };
  }

  // 大额暂停，等经理
  const decision = interrupt({
    type: "manager_approval",
    payload: {
      orderId: `ORD-${Date.now()}`,
      product: order.product,
      quantity: order.quantity,
      totalPrice: order.totalPrice,
      threshold: APPROVAL_THRESHOLD,
    },
  });

  if (decision.action === "approve") {
    return {
      status: "approved" as const,
      result: `经理批准（备注：${decision.comment ?? "无"}）`,
    };
  }

  return {
    status: "rejected" as const,
    result: `经理拒绝（原因：${decision.reason ?? "未说明"}）`,
  };
}

// 3. 处理订单
async function processOrder(state: typeof OrderState.State) {
  if (state.status !== "approved") {
    return { result: state.result || "订单未通过审批" };
  }
  const order = state.orderDetails!;
  return {
    status: "completed" as const,
    result: `订单 ${order.product} x${order.quantity} 处理完成`,
  };
}

// 4. 组图
const graph = new StateGraph(OrderState)
  .addNode("parse", parseOrder)
  .addNode("approval", managerApproval)
  .addNode("process", processOrder)
  .addEdge(START, "parse")
  .addEdge("parse", "approval")
  .addEdge("approval", "process")
  .addEdge("process", END);

const app = graph.compile({ checkpointer: new MemorySaver() });

// 5. 跑
const cfg = { configurable: { thread_id: "order-2026-001" } };

console.log("--- 第一次 invoke（应该在审批处暂停）---");
const r1 = await app.invoke({ input: "买 3 台 MacBook Pro" }, cfg);
console.log("status:", r1.status);

const state = await app.getState(cfg);
const pending = state.tasks[0]?.interrupts?.[0]?.value;
console.log("等待审批:", pending);

// 6. 模拟经理点"批准"
console.log("\n--- 经理审批 ---");
const r2 = await app.invoke(
  new Command({ resume: { action: "approve", comment: "大客户加急" } }),
  cfg
);
console.log("最终结果:", r2.result);
```

跑下来输出：

```
--- 第一次 invoke（应该在审批处暂停）---
status: pending
等待审批: {
  type: 'manager_approval',
  payload: {
    orderId: 'ORD-1748xxxxxxxxx',
    product: 'MacBook Pro',
    quantity: 3,
    totalPrice: 15000,
    threshold: 5000
  }
}

--- 经理审批 ---
最终结果: 订单 MacBook Pro x3 处理完成
```

## 跨进程恢复：长会话断点

`interrupt` 配合 `PostgresSaver` 能做到真正的"暂停几天再回来"。流程：

1. Web 后端收到请求，跑 graph，碰到 interrupt
2. 后端从 `app.getState(cfg)` 拿到 pending interrupt，**返回 HTTP 200 + 待审批载荷给前端**
3. 前端展示给运维（可能是邮件通知、企业微信卡片、内部审批系统）
4. **几小时甚至几天后**，运维在 Web UI 点了"批准"
5. 后端收到 webhook / 用户点击，凭原 `thread_id` 调 `app.invoke(new Command({ resume }), cfg)`
6. graph 从暂停点继续，跑完返回最终结果

期间后端进程可以重启、扩容、迁移，因为所有 state 都在 Postgres 里。这是 [LangGraph State 与 Checkpointer](./04-langgraph-state.md) 里讲的"thread 持久化"在 HITL 上的直接应用。

**几个生产建议**：

| 问题 | 处理 |
|------|------|
| 怎么通知审批人？ | 不要轮询。在 interrupt 后直接发企业微信卡片 / 邮件，带 webhook URL |
| 怎么处理审批超时？ | 写个定时任务扫超过 24h 还在 pending 的 thread，自动 `Command({ resume: { action: "reject", reason: "timeout" } })` |
| 怎么防止重复 resume？ | resume 接口加幂等 token，凭 `(thread_id, checkpoint_id)` 去重 |
| 怎么审计谁批准的？ | resume payload 里带 approver userId，在节点函数里写一条 audit log |

## 跟 Multi-Agent 配合

[Multi-Agent](./08-multi-agent.md) 里的退款 Agent 一上来就该挂 interrupt——退款是不可逆操作。两种集成方式：

1. 用 `createAgent` 创建退款 Agent 时直接在 `interrupts.beforeToolCall.tools` 里写 `["initiate_refund"]`
2. 在 supervisor graph 的"调用退款 Agent"节点前面塞一个动态 interrupt 节点，按金额阈值决定要不要暂停

推荐方式 1——审批逻辑紧贴工具更内聚。整个多 Agent 系统的 supervisor 不用关心这件事。

## 几个常见坑

### checkpointer 必须显式配

没有 checkpointer，interrupt 没法持久化暂停状态，graph 直接报错。`createAgent` 默认不带 checkpointer，必须显式传。

### resume 类型要稳定

前端传 `{ action: "approve" }` 后端期望 `{ approved: true }`，运行时不报错但行为错。**约定 resume schema 用 zod 校验**：

```typescript
const resumeSchema = z.object({
  action: z.enum(["approve", "reject", "modify"]),
  reason: z.string().optional(),
  newArgs: z.record(z.unknown()).optional(),
});

async function approvalNode(state: ...) {
  const raw = interrupt({...});
  const decision = resumeSchema.parse(raw); // 失败抛错，比静默走错路径好
  // ...
}
```

### 不要在 interrupt 之后做副作用

`interrupt` 抛出之后整个节点函数会被重新执行——下次 resume 时，节点函数从头跑一遍，到 `interrupt` 那行才停。所以：

```typescript
async function badNode(state: ...) {
  await logToDB("starting"); // ← resume 时会被再调一次！
  const decision = interrupt({...});
  // ...
}
```

要做副作用，放在 `interrupt` 之后或者放在另一个节点里。

### thread_id 不能用 UUID 临时生成

每次都新生成一个 thread_id，根本没法 resume——你不知道 resume 时该用哪个 ID。生产里 thread_id 必须跟业务实体绑定：`order-{orderId}`、`session-{userId}-{sessionId}`。

## 小结

Human-in-the-Loop 用 `interrupt()` 在节点内暂停 graph、用 `Command({ resume })` 喂回人决策。`createAgent` 直接支持 `interrupts.beforeToolCall` 声明式配置，手写 graph 时用动态 `interrupt()`。配合 checkpointer 可以做到跨进程长时间暂停。修改决策走"相同 message id 替换"的技巧。

至此模块 05 的核心架构全部讲完——`createAgent` 基础、ReAct 循环、Plan-and-Execute、Self-Reflection、Multi-Agent、HITL、LangGraph 底层、State 与 Checkpointer、Middleware 系统、流式输出。下一步进入 [模块 06：RAG](../06-rag/)，把外部知识接入 Agent。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
