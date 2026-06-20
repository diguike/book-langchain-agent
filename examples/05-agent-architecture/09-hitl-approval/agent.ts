// 配套示例：05-agent-architecture/09-human-in-the-loop.md
// 用 humanInTheLoopMiddleware 给高风险工具加"执行前审批"。
// 流程：第一次 invoke → 命中 delete_rows 审批暂停（result.__interrupt__）
//       → 用 Command({ resume: { decisions: [{ type: "approve" }] } }) 续跑。
//
// 跑法：先启动 Mock LLM（examples/_shared/mock-llm/server.mjs），再 `npm install && npm start`。
// 关键点：humanInTheLoopMiddleware 必须配 checkpointer + thread_id，否则无法持久化暂停点。
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver, Command } from "@langchain/langgraph";
import { z } from "zod";

// 没设 OPENAI_API_KEY 时，自动指向本地 Mock LLM Server。
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

// 高风险工具：删除数据。执行前要人工审批。
const deleteRows = tool(
  async ({ table, where }) => `已删除 ${table} 中 WHERE ${where} 的数据`,
  {
    name: "delete_rows",
    description: "从表中删除满足条件的行（高风险）",
    schema: z.object({
      table: z.string().describe("表名"),
      where: z.string().describe("WHERE 条件"),
    }),
  }
);

// 只读工具：查询行数。直接放行，不审批。
const queryRows = tool(async ({ table }) => `表 ${table} 共 1234 行`, {
  name: "query_rows",
  description: "查询表的行数（只读）",
  schema: z.object({ table: z.string().describe("表名") }),
});

const agent = createAgent({
  model: makeModel(),
  tools: [deleteRows, queryRows],
  systemPrompt:
    "你是数据库管理助手。用户要删数据时，调用 delete_rows，table 取用户说的表名，where 取用户描述的条件。",
  middleware: [
    humanInTheLoopMiddleware({
      // 按工具名声明审批策略
      interruptOn: {
        delete_rows: {
          allowedDecisions: ["approve", "edit", "reject"],
          description: "删除操作需人工审批，请核对 table 与 where",
        },
        query_rows: false, // 只读，直接放行
      },
      descriptionPrefix: "高风险操作待审批",
    }),
  ],
  // humanInTheLoopMiddleware 必须配 checkpointer
  checkpointer: new MemorySaver(),
});

async function main() {
  // thread_id 绑定业务会话，resume 时凭它找回暂停点
  const cfg = { configurable: { thread_id: "admin-session-1" } };

  console.log("=== 第一次 invoke：应在 delete_rows 执行前暂停 ===");
  const r1 = await agent.invoke(
    {
      messages: [
        { role: "user", content: "把 users 表里 status='deleted' 的全删了" },
      ],
    },
    cfg
  );

  // 命中审批暂停：待审信息在 __interrupt__ 里
  if (r1.__interrupt__) {
    const value = r1.__interrupt__[0].value as {
      actionRequests?: Array<{ name: string; args: Record<string, unknown> }>;
    };
    console.log("命中审批暂停 __interrupt__：");
    console.log(JSON.stringify(value.actionRequests ?? value, null, 2));
  } else {
    console.log("（没有命中暂停，模型可能没调 delete_rows）");
    console.log("最后一条消息:", r1.messages.at(-1)?.text);
    return;
  }

  console.log("\n=== 运维点'批准'：用 Command({ resume }) 续跑 ===");
  const r2 = await agent.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    cfg
  );
  console.log("续跑完成，最后一条消息:");
  console.log(r2.messages.at(-1)?.text);
}

main();
