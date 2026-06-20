// 验证所有示例：对每个示例做 npm install + tsc 类型检查（RUN=1 时还实际运行）。
// 用法：node examples/verify.mjs      # 仅 typecheck
//       RUN=1 node examples/verify.mjs # 同时运行（需 mock 服务在 11434 或设了 OPENAI_API_KEY）
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const RUN = process.env.RUN === "1";

// 找出所有"含 package.json 的叶子目录"，排除 _shared 和 node_modules
function findExamples(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "_shared") continue;
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "package.json"))) acc.push(p);
    else findExamples(p, acc);
  }
  return acc;
}

function sh(cmd, args, cwd, timeout) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: "pipe" });
}

const examples = findExamples(root).sort();
console.log(`发现 ${examples.length} 个示例\n`);
const results = [];

for (const dir of examples) {
  const rel = dir.replace(root + "/", "");
  process.stdout.write(`▶ ${rel} ... `);

  const install = sh("npm", ["install", "--no-audit", "--no-fund"], dir, 300000);
  if (install.status !== 0) {
    console.log("❌ install 失败");
    results.push({ rel, ok: false, stage: "install", msg: (install.stderr || "").slice(-400) });
    continue;
  }

  const tsc = sh(join(dir, "node_modules/.bin/tsc"), ["--noEmit"], dir, 120000);
  if (tsc.status !== 0) {
    console.log("❌ typecheck 失败");
    results.push({ rel, ok: false, stage: "typecheck", msg: (tsc.stdout || tsc.stderr || "").slice(-600) });
    continue;
  }

  if (RUN) {
    const run = sh(join(dir, "node_modules/.bin/tsx"), ["agent.ts"], dir, 180000);
    // 有些示例入口不是 agent.ts，按 package.json 的 start 兜底
    const runOk = run.status === 0;
    if (!runOk) {
      const start = sh("npm", ["start"], dir, 180000);
      if (start.status !== 0) {
        console.log("❌ run 失败");
        results.push({ rel, ok: false, stage: "run", msg: (start.stdout || start.stderr || "").slice(-600) });
        continue;
      }
    }
    console.log("✅ typecheck + run");
  } else {
    console.log("✅ typecheck");
  }
  results.push({ rel, ok: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) {
  console.log(`\n❌ ${f.rel} [${f.stage}]\n${f.msg}`);
}
process.exit(failed.length ? 1 : 0);
