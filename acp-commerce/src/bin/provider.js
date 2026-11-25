#!/usr/bin/env node
// 실거래 provider 상주 프로세스 (공식 acp-cli 사용)
//   IS_TESTNET=true node src/bin/provider.js            ← 테스트넷 (승인 불필요)
//   node src/bin/provider.js                            ← 메인넷 (관리자 'mainnet' 승인 필요)
//   옵션: --dashboard [port]  대시보드 동시 기동
import { loadConfig, applyRuntimeOverlay } from "../config.js";
import { Store } from "../core/store.js";
import { Guard } from "../core/guard.js";
import { ProviderRuntime } from "../core/provider.js";
import { CliAdapter } from "../adapters/cli.js";
import { createDashboard } from "../dashboard/server.js";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { cliOps } from "../growth/acpOps.js";
import { runGrowthCycle, toMarkdown } from "../growth/cycle.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
applyRuntimeOverlay(cfg, store.state); // 운영 중 가격·출시 상품 반영
const guard = new Guard(store, cfg.policy);

let adapter;
try {
  adapter = new CliAdapter({ guard, dataDir: cfg.dataDir });
} catch (e) {
  console.error(`[provider] 기동 차단: ${e.message}`);
  process.exit(2);
}

const runtime = new ProviderRuntime({ adapter, store, offerings: cfg.offerings, policy: cfg.policy });
try {
  await runtime.start();
} catch (e) {
  console.error(`[provider] 사전점검 실패: ${e.message}`);
  console.error("  조치: ① acp configure start --json → 관리자 로그인 ② acp agent create ③ acp agent add-signer (README '테스트넷 개시 절차' 참고)");
  store.setHeartbeat({ state: "stopped", lastError: e.message });
  await adapter.stop();
  process.exit(3);
}
const walletTimer = setInterval(() => runtime.refreshWallet(), 10 * 60 * 1000);

// 주간 성장 사이클: 1시간마다 확인, 마지막 실행 후 intervalDays 경과 시 실행 (provider와 같은 오퍼링 배열을 공유 → 신상품 즉시 판매)
let growthRunning = false;
const growthTick = async () => {
  const last = store.state.growth.at(-1)?.at;
  const due = !last || Date.now() - Date.parse(last) >= (cfg.policy.growth?.intervalDays ?? 7) * 86400e3;
  if (!due || growthRunning) return;
  growthRunning = true;
  try {
    const report = await runGrowthCycle({ store, cfg, ops: cliOps(adapter), guard, reportDir: join(cfg.dataDir, "growth"), log: console.log });
    // 주간 보고서 메일 발송 (선택): 에이전트 전용 메일함(acp email)으로 관리자에게 전송
    if (process.env.REPORT_EMAIL) {
      try {
        await adapter.run(["email", "compose", "--to", process.env.REPORT_EMAIL, "--subject", `[ACP 주간 성장 보고] ${report.at.slice(0, 10)}`, "--body", toMarkdown(report)]);
      } catch (e) {
        console.error(`[growth] report email failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[growth] cycle failed: ${e.message}`);
    store.addSignal({ kind: "growth_error", detail: e.message });
  } finally {
    growthRunning = false;
  }
};
const growthTimer = setInterval(growthTick, 60 * 60 * 1000);
setTimeout(growthTick, 60 * 1000);

const di = process.argv.indexOf("--dashboard");
if (di > -1) {
  const port = Number(process.argv[di + 1]) || 8787;
  createDashboard({ store, ...cfg }).listen(port, "127.0.0.1", () => console.log(`[dashboard] http://127.0.0.1:${port}`));
}

const shutdown = async () => {
  clearInterval(walletTimer);
  clearInterval(growthTimer);
  await runtime.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
