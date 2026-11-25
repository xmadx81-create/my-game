#!/usr/bin/env node
// 모의 거래 환경 전체 흐름 검증: 주문 수신 → 사전검증 → 예산제시 → 입금 → 처리 → 자동검수 → 납품 → 구매자 검수 → 정산
//   node src/bin/simulate.js [--repeat N] [--dashboard [port]]
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ROOT } from "../config.js";
import { Store } from "../core/store.js";
import { ProviderRuntime } from "../core/provider.js";
import { MockMarketplace, MockAdapter } from "../adapters/mock.js";
import { createDashboard } from "../dashboard/server.js";
import { computeMetrics } from "../core/metrics.js";
import { SCENARIOS, verifyDeliverable } from "../sim/scenarios.js";
import { runGrowthCycle } from "../growth/cycle.js";
import { Guard } from "../core/guard.js";

const cfg = loadConfig();
const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1]) || 1;
const dataDir = process.env.ACP_DATA_DIR || join(ROOT, "data-sim");
rmSync(dataDir, { recursive: true, force: true });

const store = new Store(dataDir);
const market = new MockMarketplace({ feeRate: cfg.policy.protocolFeeRate });
const runtime = new ProviderRuntime({ adapter: new MockAdapter(market), store, offerings: cfg.offerings, policy: cfg.policy, log: () => {} });
await runtime.start();

const buyer = "0xbuyer00000000000000000000000000000000001";
market.fundWallet(buyer, 100);
const startBuyer = market.balance(buyer);

const results = [];
for (let r = 0; r < repeat; r++) {
  for (const s of SCENARIOS) {
    const id = market.createJob({ buyer, offeringName: s.offeringName, requirement: s.requirement, autoFund: s.autoFund ?? true, evaluate: s.evaluate || verifyDeliverable });
    results.push({ id, s });
  }
}
await market.idle();
for (const { id, s } of results) if (s.expect === "expired") market.expire(id);
await market.idle();
await runtime.refreshWallet();

let pass = 0;
const rows = results.map(({ id, s }) => {
  const job = store.job(id) || {};
  const expected = s.expect || "completed";
  const ok = job.status === expected && (expected !== "completed" || market.jobs.get(id).status === "completed");
  if (ok) pass++;
  return { job: id, 시나리오: s.label, 기대: expected, 결과: job.status, 판정: ok ? "PASS" : "FAIL", 단가: job.price ?? "-", 순수익: job.netUsdc ?? "-", 사유: (job.failReason || "").slice(0, 40) };
});
console.table(rows);

const m = computeMetrics(store.state, cfg);
const provBal = market.balance(market.providerAddress);
const treasury = market.balance("0xtreasury");
const spent = +(startBuyer - market.balance(buyer)).toFixed(6);
const reconciled = Math.abs(spent - (provBal + treasury)) < 1e-6 && Math.abs(provBal - m.monthly.netUsdc) < 1e-6 && market.escrow.size === 0;
console.log(`\n시나리오 ${pass}/${rows.length} 통과`);
console.log(`정산 대사: 구매자 지출 ${spent} = 판매자 수령 ${provBal} + 수수료 ${treasury} | 장부 순매출 ${m.monthly.netUsdc} | 잔여 에스크로 ${market.escrow.size}건 → ${reconciled ? "일치" : "불일치"}`);
console.log(`AI 사용료 ${m.costs.aiCostTotalUsd} USD · 이번달 순이익 ${m.monthly.profitUsd} USD`);

// 성장 사이클 1회 (모의 마켓: 경쟁 상품 없음, 승인 없음 → 분석·제안만)
const simOps = { address: async () => market.providerAddress, browse: async () => [], listOfferings: async () => [], createOffering: async () => ({}), updateOfferingPrice: async () => {} };
const growth = await runGrowthCycle({ store, cfg: { ...cfg, offerings: JSON.parse(JSON.stringify(cfg.offerings)) }, ops: simOps, guard: new Guard(store, cfg.policy) });
console.log(`성장 사이클: 상품 판단 ${growth.products.map((p) => `${p.service}=${p.decision}`).join(", ")} / 신상품 ${growth.launch ? growth.launch.service + " " + growth.launch.result : "없음"} / 백로그 ${growth.backlog.length}건`);

const di = process.argv.indexOf("--dashboard");
if (di > -1) {
  const port = Number(process.argv[di + 1]) || 8787;
  createDashboard({ store, ...cfg }).listen(port, "127.0.0.1", () => console.log(`[dashboard] http://127.0.0.1:${port}  (Ctrl+C 종료)`));
} else {
  await runtime.stop();
  process.exit(pass === rows.length && reconciled ? 0 : 1);
}
