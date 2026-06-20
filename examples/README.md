# 配套示例代码

本书各章的可运行示例。每个示例是一个**独立的、能 `npm install && npm start` 跑起来的小项目**，按章节组织：

```
examples/
  _shared/
    mock-llm/         # 本地 Mock LLM 服务（接 Claude Code），让没 key 也能跑
  05-agent-architecture/
    01-basic-agent/   # 对应 05-agent-architecture/01-create-agent.md
  ...
```

## 怎么跑

### 1. 准备模型后端（二选一）

**没有 API key？** 用本地 Mock LLM（推荐，零成本）。先装并登录 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)，然后：

```bash
cd examples/_shared/mock-llm
node server.mjs          # 起在 http://localhost:11434
```

保持这个服务开着。示例默认就指向它。

**有 OpenAI key？** 直接 `export OPENAI_API_KEY=sk-...`，示例会自动走真实 OpenAI，不经过 mock。

### 2. 跑某个示例

```bash
cd examples/05-agent-architecture/01-basic-agent
npm install
npm start          # 运行
npm run typecheck  # 仅类型检查
```

## 验证全部示例

`verify.mjs` 会对每个示例做"安装 + 类型检查（+ 可选运行）"：

```bash
node examples/verify.mjs            # 仅 typecheck（快，不调模型）
RUN=1 node examples/verify.mjs      # 同时实际运行（需 mock 服务或真实 key）
```

## 约定

- 每个示例自带 `package.json` / `tsconfig.json`，依赖钉在该目录，互不干扰。
- 模型一律通过一个内联的 `makeModel()` 获取：有 `OPENAI_API_KEY` 走真实 OpenAI，否则指向本地 mock。
- 代码注释用中文、标识符用英文；与对应章节正文里的代码保持一致。
