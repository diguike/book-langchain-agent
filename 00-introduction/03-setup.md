---
title: 环境搭建指南
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/X7p7w4jFNibXH2kJzsXc8EbanYi"
last_synced: "2026-05-25T02:40:39+08:00"
---

本指南将带你从零搭建 LangChain.js 开发环境。全程预计 **30-60 分钟**，完成后你将拥有一个可运行的 TypeScript + LangChain.js 项目。

---

## 一、安装 Node.js 22+

### 推荐方式：使用 nvm

[nvm](https://github.com/nvm-sh/nvm) 允许你在同一台机器上管理多个 Node.js 版本，是业界标准做法。

```bash
# 安装 nvm（macOS / Linux）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# 重新加载 shell 配置
source ~/.bashrc  # 或 source ~/.zshrc

# 安装 Node.js 22 LTS
nvm install 22

# 设为默认版本
nvm alias default 22

# 验证安装
node --version   # 应输出 v22.x.x
npm --version    # 应输出 10.x.x 或更高
```

> **Windows 用户：** 请使用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 或直接从 [Node.js 官网](https://nodejs.org/) 下载 LTS 安装包。

### 为什么选 Node.js 22+

- **原生 ES Module 支持完善**——LangChain.js 1.x 全面使用 ESM
- **内置 `fetch` API**——不再需要 `node-fetch` 等 polyfill
- **性能提升**——V8 引擎升级带来的整体性能改善
- **LTS 长期支持**——Node.js 22 是当前 Active LTS，支持到 2027 年 4 月（Node.js 20 已于 2026 年 4 月转为 Maintenance）

---

## 二、包管理器选择

本书默认用 `npm`（Node 22+ 自带，安装最稳）。如果你已经习惯 pnpm 或 bun，把命令里的 `npm install` 换成对应命令即可。

```bash
# 验证 npm
npm --version  # 应输出 10.x 或更高
```

### 可选：pnpm（磁盘效率更高，monorepo 友好）

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

### 可选：bun（速度最快，但生态偶有兼容问题）

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

bun 同时充当运行时和包管理器，原生支持 TypeScript。部分 LangChain.js 社区集成包在 bun 下偶有兼容问题，初学者建议先用 npm + tsx 跑通。

---

## 三、项目初始化

### 3.1 创建项目目录

```bash
mkdir langchain-agent-course && cd langchain-agent-course
npm init -y
```

### 3.2 安装 TypeScript

```bash
npm install -D typescript @types/node tsx
```

- `typescript`：TypeScript 编译器
- `@types/node`：Node.js 类型定义
- `tsx`：TypeScript 执行器，支持直接运行 `.ts` 文件，无需预编译

### 3.3 配置 tsconfig.json

在项目根目录创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**关键配置说明：**

| 配置项 | 值 | 为什么 |
|--------|-----|--------|
| `target` | `ES2022` | 支持 top-level await、`Array.at()` 等现代语法 |
| `module` | `NodeNext` | 与 Node.js 的 ESM 实现对齐 |
| `moduleResolution` | `NodeNext` | 正确解析 `.js` 扩展名的导入 |
| `strict` | `true` | 启用所有严格类型检查，减少运行时错误 |
| `skipLibCheck` | `true` | 跳过第三方库的类型检查，加快编译速度 |

### 3.4 配置 package.json

确保 `package.json` 中包含以下字段：

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

`"type": "module"` 是启用 ES Module 的关键配置，没有它 Node.js 会将 `.js` 文件当作 CommonJS 处理。

---

## 四、安装 LangChain.js 核心包

```bash
npm install @langchain/core @langchain/openai @langchain/anthropic langchain
```

各包的职责：

| 包名 | 职责 | 何时用到 |
|------|------|---------|
| `@langchain/core` | 核心抽象：Runnable、Message、Prompt Template、Output Parser | 每个模块都会用 |
| `@langchain/openai` | OpenAI 模型集成（GPT-5、GPT-4o、Embedding） | 模块 1 开始 |
| `@langchain/anthropic` | Anthropic Claude 4.x 集成 | 模块 1 开始 |
| `langchain` | Agent 主入口：`createAgent`、Middleware、Retriever | 模块 5 开始 |

后续模块中我们还会逐步安装：

```bash
# 模块 5: Agent 架构
npm install @langchain/langgraph

# 模块 6: RAG
npm install @langchain/community chromadb

# 模块 7: 可观测性
npm install langsmith
```

---

## 五、环境变量管理

### 5.1 安装 dotenv

```bash
npm install dotenv
```

### 5.2 创建 .env 文件

在项目根目录创建 `.env` 文件：

```bash
# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx

# LangSmith（模块 7 开始使用）
LANGSMITH_API_KEY=lsv2_pt_xxxxxxxxxxxxxxxxxxxxxxxx
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=langchain-agent-course
```

### 5.3 将 .env 加入 .gitignore

```bash
echo ".env" >> .gitignore
```

> **安全警告：** 永远不要将包含 API Key 的 `.env` 文件提交到 Git 仓库。可以创建一个 `.env.example` 文件，只包含变量名不包含值，作为团队协作的参考模板。

---

## 六、LLM Provider API Key 获取

### OpenAI API Key

1. 访问 [https://platform.openai.com/](https://platform.openai.com/)
2. 注册或登录账号
3. 进入 **API Keys** 页面：Settings → API Keys
4. 点击 **Create new secret key**
5. 复制生成的 Key（以 `sk-proj-` 开头），粘贴到 `.env` 文件中

> **费用提示：** OpenAI API 按用量计费。建议先设置 Usage Limit（如 $10/月），课程学习期间的开销通常在 $5-20 之间。开发调试时优先使用 `gpt-4o-mini` 以降低成本。

### Anthropic API Key

1. 访问 [https://console.anthropic.com/](https://console.anthropic.com/)
2. 注册或登录账号
3. 进入 **API Keys** 页面
4. 点击 **Create Key**
5. 复制生成的 Key（以 `sk-ant-` 开头），粘贴到 `.env` 文件中

> **提示：** 课程中大部分示例同时提供 OpenAI 和 Anthropic 两套代码。你只需要准备其中一个 Provider 的 Key 即可开始学习，后续按需添加。

---

## 七、LangSmith 账号注册与配置

LangSmith 是 LangChain 官方的可观测性平台，我们将在模块 7 深入使用，但建议现在就注册并配置好。

### 注册步骤

1. 访问 [https://smith.langchain.com/](https://smith.langchain.com/)
2. 使用 GitHub 或 Google 账号注册
3. 进入 **Settings → API Keys**
4. 创建一个新的 API Key（以 `lsv2_pt_` 开头）
5. 将 Key 添加到 `.env` 文件中

### 环境变量配置

```bash
# 在 .env 中添加以下三行
LANGSMITH_API_KEY=lsv2_pt_xxxxxxxxxxxxxxxxxxxxxxxx
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=langchain-agent-course
```

- `LANGCHAIN_TRACING_V2=true`：启用自动追踪，所有 LangChain 调用都会被记录
- `LANGCHAIN_PROJECT`：项目名称，用于在 LangSmith 面板中分组查看追踪数据

> **提示：** LangSmith 提供免费额度，足够课程学习使用。如果你暂时不想注册，可以将 `LANGCHAIN_TRACING_V2` 设为 `false`，不影响核心功能。

---

## 八、VS Code 推荐插件

以下插件将显著提升 LangChain.js 开发体验：

| 插件名 | 插件 ID | 用途 |
|--------|---------|------|
| **TypeScript + JavaScript** | 内置 | TypeScript 智能提示（VS Code 内置） |
| **ESLint** | `dbaeumer.vscode-eslint` | 代码规范检查 |
| **Prettier** | `esbenp.prettier-vscode` | 代码格式化 |
| **Error Lens** | `usernamehw.errorlens` | 内联显示错误信息，无需悬浮查看 |
| **dotENV** | `mikestead.dotenv` | `.env` 文件语法高亮 |
| **REST Client** | `humao.rest-client` | 直接在 VS Code 中测试 HTTP API |
| **Todo Tree** | `Gruntfuggly.todo-tree` | 追踪代码中的 TODO/FIXME 标记 |

### 推荐 VS Code 配置

在项目根目录创建 `.vscode/settings.json`：

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "typescript.preferences.importModuleSpecifier": "non-relative"
}
```

---

## 九、Hello World —— 验证安装

写一段完整代码，验证所有环境配置都对：

### 9.1 创建源文件

创建 `src/index.ts`：

```typescript
import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";

// ============================================
// 1. 基础调用：直接调用模型
// ============================================
async function basicInvoke() {
  console.log("=== 基础调用 ===\n");

  // 选择你有 API Key 的 Provider，注释掉另一个
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
  });

  // 如果你使用 Anthropic，取消下面的注释：
  // const model = new ChatAnthropic({
  //   model: "claude-haiku-4-5",
  //   temperature: 0,
  // });

  const response = await model.invoke([
    new SystemMessage("你是一个乐于助人的 AI 助手。请用中文回答。"),
    new HumanMessage("用一句话解释什么是 LangChain。"),
  ]);

  // 1.x 推荐用 response.text 取纯文本，多模态场景读 response.contentBlocks
  console.log("模型回复:", response.text);
  console.log("Token 使用:", response.usage_metadata);
  console.log();
}

// ============================================
// 2. 流式输出：逐 Token 打印
// ============================================
async function streamOutput() {
  console.log("=== 流式输出 ===\n");

  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0.7,
  });

  const stream = await model.stream([
    new HumanMessage("写一首关于编程的四行诗。"),
  ]);

  process.stdout.write("模型回复: ");
  for await (const chunk of stream) {
    process.stdout.write(chunk.text ?? "");
  }
  console.log("\n");
}

// ============================================
// 3. Chain 组合：模型 + 输出解析器
// ============================================
async function chainExample() {
  console.log("=== Chain 组合 ===\n");

  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
  });

  // 使用 pipe() 将模型和输出解析器连接成 Chain
  const chain = model.pipe(new StringOutputParser());

  // invoke 的返回值直接是 string，不再是 AIMessage
  const result: string = await chain.invoke([
    new HumanMessage("用一个词形容 TypeScript。"),
  ]);

  console.log("解析后的结果:", result);
  console.log("结果类型:", typeof result);
  console.log();
}

// ============================================
// 运行所有示例
// ============================================
async function main() {
  console.log("LangChain.js 环境验证\n");

  try {
    await basicInvoke();
    await streamOutput();
    await chainExample();
    console.log("[OK] 所有验证通过，环境已准备就绪。");
  } catch (error) {
    console.error("[FAIL] 验证失败:", error);
    console.error("\n请检查：");
    console.error("1. .env 文件是否存在且包含正确的 API Key");
    console.error("2. API Key 是否有效且有足够额度");
    console.error("3. 网络是否能访问 API 服务");
    process.exit(1);
  }
}

main();
```

### 9.2 运行验证

```bash
# 使用 tsx 直接运行 TypeScript
npm start

# 或使用 bun
bun src/index.ts
```

### 9.3 预期输出

如果一切配置正确，你会看到类似以下的输出：

```
LangChain.js 环境验证

=== 基础调用 ===

模型回复: LangChain 是一个用于构建基于大语言模型（LLM）应用的开发框架，提供了模型调用、提示管理、记忆、工具集成等模块化组件。
Token 使用: { input_tokens: 32, output_tokens: 58, total_tokens: 90 }

=== 流式输出 ===

模型回复: 键盘敲击似春雨，代码如诗写华章。Bug 退散逻辑明，编程之路步步光。

=== Chain 组合 ===

解析后的结果: 安全
结果类型: string

[OK] 所有验证通过，环境已准备就绪。
```

---

## 最终项目结构

完成环境搭建后，你的项目目录结构应该是：

```
langchain-agent-course/
├── .env                  # API Key（不提交到 Git）
├── .env.example          # API Key 模板（提交到 Git）
├── .gitignore
├── .vscode/
│   └── settings.json
├── package.json
├── package-lock.json
├── tsconfig.json
└── src/
    └── index.ts          # Hello World 验证代码
```

---

## 常见问题排查

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| `ERR_MODULE_NOT_FOUND` | package.json 缺少 `"type": "module"` | 添加 `"type": "module"` 到 package.json |
| `Cannot find module '@langchain/openai'` | 包未安装或 node_modules 损坏 | 删除 `node_modules` 后重新 `npm install` |
| `401 Unauthorized` | API Key 无效或未设置 | 检查 `.env` 文件中的 Key 是否正确 |
| `429 Rate Limit` | API 调用频率过高或额度用完 | 等待几秒重试，或检查 Provider 的用量面板 |
| `ECONNREFUSED` / `ETIMEDOUT` | 网络无法连接 API 服务 | 检查网络连接或配置代理 |
| TypeScript 类型报错 | `@types/node` 版本不匹配 | 确保安装了与 Node.js 22 对应的 `@types/node` |

---

环境就绪。下一步进入 [模块 1: 核心抽象](../01-core-abstractions/01-runnable-interface.md) 开始正式学习。

---

> 本文摘自[《LangChain.js Agent 开发权威指南》](https://github.com/diguike/book-langchain-agent)，作者[递归客](https://inferloop.dev)。
