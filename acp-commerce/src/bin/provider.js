#!/usr/bin/env node
// 실거래 provider 상주 프로세스 (공식 acp-cli 사용)
//   IS_TESTNET=true node src/bin/provider.js            ← 테스트넷 (승인 불필요)
//   node src/bin/provider.js                            ← 메인넷 (관리자 'mainnet' 승인 필요)
//   옵션: --dashboard [port]  대시보드 동시 기동
import { loadConfig } from "../config.js";
import { Store } from "../core/store.js";
import { Guard } from "../core/guard.js";
import { ProviderRuntime } from "../core/provider.js";
import { CliAdapter } from "../adapters/cli.js";
import { createDashboard } from "../dashboard/server.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
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

const di = process.argv.indexOf("--dashboard");
if (di > -1) {
  const port = Number(process.argv[di + 1]) || 8787;
  createDashboard({ store, ...cfg }).listen(port, "127.0.0.1", () => console.log(`[dashboard] http://127.0.0.1:${port}`));
}

const shutdown = async () => {
  clearInterval(walletTimer);
  await runtime.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
