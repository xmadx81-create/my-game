// 전체 거래 흐름 E2E: 모의 마켓 + 실제 provider 런타임 / 승인 가드 / 실거래 CLI 어댑터(가짜 바이너리)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/core/store.js";
import { Guard } from "../src/core/guard.js";
import { ProviderRuntime } from "../src/core/provider.js";
import { MockMarketplace, MockAdapter } from "../src/adapters/mock.js";
import { CliAdapter } from "../src/adapters/cli.js";
import { computeMetrics } from "../src/core/metrics.js";
import { SCENARIOS, verifyDeliverable, SAMPLE_CSV } from "../src/sim/scenarios.js";

const cfg = loadConfig();
const tmp = () => mkdtempSync(join(tmpdir(), "acp-test-"));

async function setup() {
  const store = new Store(tmp());
  const market = new MockMarketplace({ feeRate: cfg.policy.protocolFeeRate });
  const runtime = new ProviderRuntime({ adapter: new MockAdapter(market), store, offerings: cfg.offerings, policy: cfg.policy, log: () => {} });
  await runtime.start();
  const buyer = "0xbuyer";
  market.fundWallet(buyer, 50);
  return { store, market, runtime, buyer };
}

test("주문수신→예산→입금→처리→검수→납품→정산 전 시나리오", async () => {
  const { store, market, runtime, buyer } = await setup();
  const ids = SCENARIOS.map((s) => [market.createJob({ buyer, offeringName: s.offeringName, requirement: s.requirement, autoFund: s.autoFund ?? true, evaluate: s.evaluate || verifyDeliverable }), s]);
  await market.idle();
  for (const [id, s] of ids) if (s.expect === "expired") market.expire(id);
  await market.idle();
  for (const [id, s] of ids) assert.equal(store.job(id).status, s.expect || "completed", `${s.label}`);

  // 정산 대사: 구매자 지출 = 판매자 순수령 + 프로토콜 수수료, 장부와 일치, 에스크로 잔액 0
  const spent = 50 - market.balance(buyer);
  const prov = market.balance(market.providerAddress);
  assert.ok(Math.abs(spent - prov - market.balance("0xtreasury")) < 1e-9);
  const m = computeMetrics(store.state, cfg);
  assert.ok(Math.abs(m.monthly.netUsdc - prov) < 1e-9);
  assert.equal(market.escrow.size, 0);
  assert.equal(m.orders.completed, 6);
  assert.equal(m.orders.failed, 1);
  assert.equal(m.orders.declined, 3);
  assert.equal(m.costs.aiCostTotalUsd, 0);
  // 사전 거절된 주문은 예산이 제시되지 않음 → 구매자 자금 이동 없음
  for (const [id, s] of ids) if (s.expect === "declined") assert.equal(market.jobs.get(id).budget, null);
  await runtime.stop();
});

test("멱등성: 동일 requirement 재전송 시 중복 예산 제시 없음", async () => {
  const { store, market, runtime, buyer } = await setup();
  const id = market.createJob({ buyer, offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV }, autoFund: false });
  await market.idle();
  market.msg(market.jobs.get(id), buyer, "requirement", JSON.stringify({ data: SAMPLE_CSV }));
  await market.idle();
  assert.equal(store.job(id).status, "budget_set");
  assert.equal(store.job(id).history.filter((h) => h.status === "budget_set").length, 1);
  await runtime.stop();
});

test("일일 처리 한도 초과 시 사전 거절", async () => {
  const { store, market, runtime, buyer } = await setup();
  runtime.policy = { ...cfg.policy, dailyJobCap: 1 };
  const a = market.createJob({ buyer, offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV } });
  await market.idle();
  const b = market.createJob({ buyer, offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV } });
  await market.idle();
  assert.equal(store.job(a).status, "completed");
  assert.equal(store.job(b).status, "declined");
  assert.match(store.job(b).failReason, /CAPACITY/);
  await runtime.stop();
});

test("승인 가드: 메인넷·등록 차단, 토큰발행·트레이딩은 승인 불가", () => {
  const store = new Store(tmp());
  const g = new Guard(store, cfg.policy);
  assert.throws(() => g.require("mainnet"), /관리자 승인 필요/);
  assert.throws(() => g.require("withdraw"), /관리자 승인 필요/);
  g.approve("mainnet", "admin", { note: "test" });
  assert.doesNotThrow(() => g.require("mainnet"));
  g.revoke("mainnet");
  assert.throws(() => g.require("mainnet"));
  assert.throws(() => g.approve("tokenize", "admin"), /금지/);
  assert.throws(() => g.require("trade"), /금지/);
  assert.throws(() => g.approve("mainnet"), /--by/);
});

function fakeAcp() {
  const dir = tmp();
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const bin = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp.mjs");
  chmodSync(bin, 0o755);
  return { dir, log, bin };
}

test("CLI 어댑터: 메인넷은 승인 없으면 기동 거부", () => {
  const { dir, log, bin } = fakeAcp();
  Object.assign(process.env, { ACP_BIN: bin, FAKE_ACP_LOG: log });
  delete process.env.IS_TESTNET;
  const store = new Store(dir);
  assert.throws(() => new CliAdapter({ guard: new Guard(store, cfg.policy), dataDir: dir }), /관리자 승인 필요/);
});

test("CLI 어댑터(테스트넷): 공식 CLI 명령으로 예산 제시·납품·잔액 조회", async () => {
  const { dir, log, bin } = fakeAcp();
  Object.assign(process.env, { ACP_BIN: bin, FAKE_ACP_LOG: log, IS_TESTNET: "true" });
  const store = new Store(dir);
  const adapter = new CliAdapter({ guard: new Guard(store, cfg.policy), dataDir: dir, pollMs: 50, log: () => {} });
  assert.equal(adapter.network, "testnet");
  const runtime = new ProviderRuntime({ adapter, store, offerings: cfg.offerings, policy: cfg.policy, log: () => {} });
  await runtime.start();
  assert.equal(store.state.wallet.usdc, 12.5); // 0xbebc20 = 12,500,000 (6 decimals)

  // acp events listen 이 기록하는 NDJSON 라인을 흉내
  const ev = (entry, status) => appendFileSync(adapter.eventsFile, JSON.stringify({ jobId: "77", chainId: 84532, status, roles: ["provider"], availableTools: [], entry }) + "\n");
  ev({ kind: "system", onChainJobId: "77", chainId: 84532, event: { type: "job.created", jobId: "77", client: "0xc" } }, "open");
  ev({ kind: "message", onChainJobId: "77", chainId: 84532, from: "0xc", contentType: "requirement", content: JSON.stringify({ data: SAMPLE_CSV }) }, "open");
  const wait = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 50)); };
  await wait(() => store.job("77")?.status === "budget_set");
  assert.equal(store.job("77").service, "data-validate"); // job list의 오퍼링명으로 라우팅
  ev({ kind: "system", onChainJobId: "77", chainId: 84532, event: { type: "job.funded", jobId: "77", amount: 0.2 } }, "funded");
  await wait(() => store.job("77")?.status === "submitted");
  ev({ kind: "system", onChainJobId: "77", chainId: 84532, event: { type: "job.completed", jobId: "77", reason: "ok" } }, "completed");
  await wait(() => store.job("77")?.status === "completed");
  await runtime.stop();

  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const sb = calls.find((c) => c[0] === "provider" && c[1] === "set-budget");
  assert.deepEqual(sb, ["provider", "set-budget", "--job-id", "77", "--amount", "0.2", "--chain-id", "84532", "--json"]);
  const sub = calls.find((c) => c[0] === "provider" && c[1] === "submit");
  assert.equal(verifyDeliverable(sub[sub.indexOf("--deliverable") + 1]).ok, true);
  // 출금·송금·트레이딩·토큰발행 명령은 절대 호출되지 않음
  assert.ok(!calls.some((c) => ["trade"].includes(c[0]) || (c[0] === "wallet" && ["send-transaction", "topup"].includes(c[1])) || (c[0] === "agent" && c[1] === "tokenize")));
  assert.equal(store.job("77").netUsdc, 0.16);
});
