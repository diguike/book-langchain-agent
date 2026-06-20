// Mock LLM Server —— OpenAI Chat Completions 兼容，后端接本地 Claude Code CLI。
//
// 目的：让没有 API key 的读者也能跑通本书所有示例。
//   - 示例里用 `ChatOpenAI({ configuration: { baseURL } })` 指向本服务即可，apiKey 随便填。
//   - 本服务把 OpenAI 请求翻译成对本地 `claude -p` 的一次调用，再把结果翻回 OpenAI 格式。
//   - 支持普通文本生成 + 工具调用（function calling）+ 流式（SSE）。
//
// 用法：node server.mjs   （默认端口 11434，可用 MOCK_LLM_PORT 覆盖）
// 依赖：本机装了 Claude Code（`claude` 命令可用且已登录）。无需任何 npm 依赖。

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 11434);
// 把 OpenAI/Anthropic 风格的 model 名统一映射到一个 claude 别名
const CLAUDE_MODEL = process.env.MOCK_LLM_CLAUDE_MODEL ?? "sonnet";

// 调一次 claude -p：prompt 走 stdin，系统提示走 --system-prompt，禁用 claude 自带工具。
function callClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", CLAUDE_MODEL,
      "--system-prompt", systemPrompt,
      // 禁用 claude 自己的工具，让它只当"推理大脑"，不去执行任何东西
      "--disallowed-tools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch",
      "--output-format", "text",
    ];
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err}`));
      else resolve(out.trim());
    });
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

// 把 OpenAI messages + tools 渲染成给 claude 的系统提示 + 用户提示。
function buildPrompts(body) {
  const tools = body.tools ?? [];
  const sysParts = [];
  const transcript = [];

  for (const m of body.messages ?? []) {
    if (m.role === "system") {
      sysParts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else if (m.role === "user") {
      transcript.push(`用户: ${renderContent(m.content)}`);
    } else if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          transcript.push(`助手(调用工具 ${tc.function.name}): ${tc.function.arguments}`);
        }
      } else {
        transcript.push(`助手: ${renderContent(m.content)}`);
      }
    } else if (m.role === "tool") {
      transcript.push(`工具返回(${m.tool_call_id ?? ""}): ${renderContent(m.content)}`);
    }
  }

  let systemPrompt = sysParts.join("\n\n");

  // 有工具时，注入 function-calling 协议
  if (tools.length) {
    const toolDocs = tools
      .map((t) => `- ${t.function.name}: ${t.function.description ?? ""}\n  参数 JSON Schema: ${JSON.stringify(t.function.parameters ?? {})}`)
      .join("\n");
    systemPrompt +=
      `\n\n你是一个 Agent 框架的推理引擎。你自己不执行任何工具，只决定下一步。\n` +
      `可用工具：\n${toolDocs}\n\n` +
      `规则：\n` +
      `- 如果需要调用工具，只输出一行，格式严格为：TOOL_CALL: {"name":"工具名","arguments":{...}}，不要输出别的任何内容。\n` +
      `- 如果可以直接回答（已有足够信息，或工具结果已返回），就直接输出自然语言答案，不要带 TOOL_CALL 前缀。\n` +
      `- arguments 必须是合法 JSON，字段对应工具的参数 schema。`;
  }

  const userPrompt = transcript.join("\n") + "\n\n请给出你的下一步（按上面规则）。";
  return { systemPrompt: systemPrompt.trim(), userPrompt };
}

function renderContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join(" ");
  }
  return JSON.stringify(content ?? "");
}

// 解析 claude 输出：识别 TOOL_CALL，转成 OpenAI tool_calls；否则当普通内容。
function parseClaudeOutput(text) {
  const idx = text.indexOf("TOOL_CALL:");
  if (idx !== -1) {
    const jsonStr = text.slice(idx + "TOOL_CALL:".length).trim();
    try {
      // 截取第一个完整的 JSON 对象
      const parsed = JSON.parse(extractFirstJson(jsonStr));
      return {
        toolCall: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments ?? {}),
        },
      };
    } catch {
      // 解析失败就退化成普通文本
    }
  }
  return { content: text };
}

function extractFirstJson(s) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (s[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) return s.slice(start, i + 1);
    }
  }
  return s;
}

function makeResponseBody(model, parsed, { stream } = {}) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (parsed.toolCall) {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${Date.now()}`,
          type: "function",
          function: { name: parsed.toolCall.name, arguments: parsed.toolCall.arguments },
        },
      ],
    };
    return { id, object: stream ? "chat.completion.chunk" : "chat.completion", created, model, message };
  }
  return {
    id,
    object: stream ? "chat.completion.chunk" : "chat.completion",
    created,
    model,
    message: { role: "assistant", content: parsed.content ?? "" },
  };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", backend: "claude-code", model: CLAUDE_MODEL }));
    return;
  }
  // 兼容 OpenAI SDK 的 /v1/models 探测
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-claude", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }

    try {
      const { systemPrompt, userPrompt } = buildPrompts(body);
      const out = await callClaude(systemPrompt, userPrompt);
      const parsed = parseClaudeOutput(out);
      const model = body.model ?? "mock-claude";

      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const base = makeResponseBody(model, parsed, { stream: true });
        const finishReason = parsed.toolCall ? "tool_calls" : "stop";
        // 首块带 role / tool_calls，后续把 content 分片成打字机
        if (parsed.toolCall) {
          res.write(sse({ ...base, choices: [{ index: 0, delta: base.message, finish_reason: null }] }));
        } else {
          const text = parsed.content ?? "";
          res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
          for (const piece of chunkText(text)) {
            res.write(sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
          }
        }
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const base = makeResponseBody(model, parsed);
        const finishReason = parsed.toolCall ? "tool_calls" : "stop";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: base.id,
            object: "chat.completion",
            created: base.created,
            model,
            choices: [{ index: 0, message: base.message, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
        );
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
    }
  });
});

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function chunkText(text, size = 12) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

server.listen(PORT, () => {
  console.log(`[mock-llm] OpenAI 兼容服务已启动: http://localhost:${PORT}/v1  (后端: claude ${CLAUDE_MODEL})`);
});
