#!/usr/bin/env node
// 주간 성장 사이클 수동 실행
//   node src/bin/growth.js --dry-run     조회·분석만 (가격 변경·출시 없음)
//   node src/bin/growth.js               승인 범위 내 자동 조치 실행
import { join } from "node:path";
import { loadConfig, ROOT, applyRuntimeOverlay } from "../config.js";
import { Store } from "../core/store.js";
import { Guard } from "../core/guard.js";
import { CliAdapter } from "../adapters/cli.js";
import { cliOps } from "../growth/acpOps.js";
import { runGrowthCycle, toMarkdown } from "../growth/cycle.js";
import { registerOfferings } from "../services/index.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
applyRuntimeOverlay(cfg, store.state); // 운영 중 가격·출시 상품 반영
const guard = new Guard(store, cfg.policy);
const dryRun = process.argv.includes("--dry-run");
try {
  const adapter = new CliAdapter({ guard, dataDir: cfg.dataDir });
  registerOfferings(cfg.offerings);
  const report = await runGrowthCycle({ store, cfg, ops: cliOps(adapter), guard, dryRun, reportDir: join(cfg.dataDir, "growth"), log: console.log });
  console.log(toMarkdown(report));
} catch (e) {
  console.error(`[growth] 실패: ${e.message}`);
  process.exit(1);
}
