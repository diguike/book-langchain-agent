# Mock LLM Server

一个 OpenAI Chat Completions 兼容的本地服务，**后端接本机的 Claude Code CLI**。它的存在是为了让没有 LLM API key 的读者也能把本书所有示例真正跑起来、跑得通。

## 它解决什么

本书示例都要调模型。但不是每个读者都有 OpenAI / Anthropic 的 key。这个 mock 服务把对模型的调用转发给你本机已登录的 `claude` 命令——只要你装了 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 并登录过，示例就能零成本跑。

它实现了：

- `POST /v1/chat/completions`：普通文本生成 + **工具调用（function calling）** + 流式（SSE）。
- 把 OpenAI 的 `tools` 翻译成给 claude 的"函数调用协议"提示，再把 claude 的决策翻回 OpenAI 的 `tool_calls`。
- `GET /health`：健康检查。

因此本书所有 `createAgent` / LCEL / 工具调用示例都能直接对着它跑。

## 用法

前提：本机装了 Claude Code（`claude` 命令可用且已登录）。无需任何 npm 依赖。

```bash
node server.mjs
# [mock-llm] OpenAI 兼容服务已启动: http://localhost:11434/v1  (后端: claude sonnet)
```

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MOCK_LLM_PORT` | `11434` | 监听端口 |
| `MOCK_LLM_CLAUDE_MODEL` | `sonnet` | 转发给 `claude --model` 的模型别名 |

示例代码里用 `ChatOpenAI` 指向它即可（`apiKey` 随便填）：

```ts
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "mock-claude",
  apiKey: "mock-key",
  configuration: { baseURL: "http://localhost:11434/v1" },
});
```

设了真实 `OPENAI_API_KEY` 时，示例会自动走真实 OpenAI，不经过本服务。

## 局限

- 工具调用靠提示工程驱动 claude 输出结构化决策，对本书这种"单工具、清晰任务"的示例足够稳；极复杂的并行多工具调用可能不如真实 provider 精确。
- 不返回真实 token 用量（`usage` 全 0）。
- 仅用于**学习和本地验证**，不要拿去做生产网关。
