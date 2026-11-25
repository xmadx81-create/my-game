// 자율 성장 시스템 테스트: 가격 안전장치, 피드백 판단, 신상품 프리셋, 성장 사이클, 자산관리
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardPrice, bounds, costFloor } from "../src/growth/priceGuard.js";
import { classify, collect, decide } from "../src/growth/feedback.js";
import { CATALOG, toOffering, applyPreset } from "../src/growth/catalog.js";
import { runGrowthCycle } from "../src/growth/cycle.js";
import { treasuryReport } from "../src/growth/treasury.js";
import { fulfil, registerOfferings } from "../src/services/index.js";
import { Store } from "../src/core/store.js";
import { Guard } from "../src/core/guard.js";
import { loadConfig } from "../src/config.js";

const cfg0 = loadConfig();
const policy = cfg0.policy;
const L = { maxInputBytes: 1e6, maxRows: 2e4, maxDeliverableBytes: 5e5 };
const day = 86400e3;

test("가격 가드: 1회 변동폭 ±10%, 하한(정책·원가·기준가 -30%), 상한 2배", () => {
  const p = { service: "x", priceUsdc: 0.3, basePriceUsdc: 0.3 };
  assert.equal(guardPrice({ product: p, requested: 0.01, policy }).priceUsdc, 0.27); // -10% 캡
  assert.equal(guardPrice({ product: p, requested: 9, policy }).priceUsdc, 0.33); // +10% 캡
  assert.equal(costFloor({ protocolFeeRate: 0.2 }), 0.04); // 0.03 / 0.8 = 0.0375 → 0.04
  assert.equal(bounds(p, policy).floor, 0.21); // 0.3 × 0.7
  assert.equal(bounds(p, policy).ceiling, 0.6);
});

test("가격 가드: 무한 인하 방지 — 매주 인하 요청을 반복해도 기준가 -30%에서 멈춤", () => {
  const p = { service: "x", priceUsdc: 0.3, basePriceUsdc: 0.3 };
  const history = [];
  let now = Date.parse("2026-01-01");
  for (let week = 0; week < 20; week++) {
    const g = guardPrice({ product: p, requested: p.priceUsdc * 0.5, history, policy, now: new Date(now), evidenceChanged: true });
    if (g.changed) (history.push({ service: "x", at: new Date(now).toISOString(), from: p.priceUsdc, to: g.priceUsdc }), (p.priceUsdc = g.priceUsdc));
    now += 7 * day;
  }
  assert.equal(p.priceUsdc, 0.21);
  assert.ok(history.length <= 4);
});

test("가격 가드: 쿨다운 7일, 근거 없는 연속 인하 금지", () => {
  const p = { service: "x", priceUsdc: 0.27, basePriceUsdc: 0.3 };
  const history = [{ service: "x", at: "2026-01-01T00:00:00Z", from: 0.3, to: 0.27 }];
  assert.match(guardPrice({ product: p, requested: 0.2, history, policy, now: new Date("2026-01-03") }).blocked, /cooldown/);
  assert.match(guardPrice({ product: p, requested: 0.2, history, policy, now: new Date("2026-01-20"), evidenceChanged: false }).blocked, /consecutive decrease/);
  assert.equal(guardPrice({ product: p, requested: 0.29, history, policy, now: new Date("2026-01-20"), evidenceChanged: false }).priceUsdc, 0.29); // 인상은 허용
});

test("피드백 분류: 품질·가격·칭찬·기능요청 태그", () => {
  assert.deepEqual(classify("The output is wrong, rows missing").categories, ["quality_bug"]);
  assert.ok(classify("Too expensive").categories.includes("price"));
  assert.deepEqual(classify("Can you support Excel xlsx files?").tags, ["format:xlsx"]);
  assert.ok(classify("great, thanks").categories.includes("praise"));
});

const M = (o = {}) => ({ orders: 0, completed: 0, rejected: 0, failed: 0, declined: 0, feedback: { quality_bug: 0, price: 0, speed: 0, praise: 0, feature_request: 0 }, tags: {}, samples: [], lastOrderAt: null, ...o });

test("판단: 품질 문제 → 보완(patch) + 가격 동결 (품질 문제를 가격 인하로 덮지 않음)", () => {
  const d = decide("data-clean", M({ orders: 5, completed: 3, rejected: 2, feedback: { quality_bug: 0, price: 5, speed: 0, praise: 0, feature_request: 0 } }), { currentPrice: 0.3 });
  assert.equal(d.decision, "patch");
  assert.equal(d.priceAction, "hold");
  assert.equal(d.backlog[0].type, "patch");
});

test("판단: 같은 기능 요청 3회 이상 → 업그레이드, 출시 후 1단계 인상", () => {
  const d = decide("data-transform", M({ tags: { "format:xlsx": 3 } }), { currentPrice: 0.25 });
  assert.equal(d.decision, "upgrade");
  assert.equal(d.priceAction, "hold");
  assert.equal(d.backlog[0].tag, "format:xlsx");
  assert.equal(decide("data-transform", M(), { currentPrice: 0.25, upgradeShipped: true }).priceAction, "increase");
});

test("판단: 수요 강함 → 인상 / 주문 없음+경쟁 저가 → 인하 / 주문 없음+경쟁 없음 → 유지", () => {
  assert.equal(decide("s", M({ orders: 25, completed: 25 }), { currentPrice: 0.2 }).priceAction, "increase");
  const now = new Date("2026-02-01");
  assert.equal(decide("s", M({ lastOrderAt: "2026-01-01T00:00:00Z" }), { currentPrice: 0.3, competitorLowest: 0.2, now }).priceAction, "decrease");
  assert.equal(decide("s", M(), { currentPrice: 0.3, competitorLowest: null, now }).priceAction, "hold");
});

test("피드백 수집: 메시지·거절·사전거절 신호 → 상품별 지표·태그", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const at = "2026-01-30T00:00:00Z";
  const state = {
    jobs: { 1: { service: "data-clean", status: "rejected", createdAt: at }, 2: { service: "data-clean", status: "completed", createdAt: at } },
    feedback: [{ at, service: "data-clean", source: "rejection", text: "wrong date format" }, { at, service: "data-clean", source: "message", text: "please support xlsx" }],
    signals: [{ at, kind: "invalid_request", code: "BAD_FORMAT", detail: "Unsupported format: xlsx", service: "data-clean" }],
  };
  const m = collect(state, { now })["data-clean"];
  assert.equal(m.orders, 2);
  assert.equal(m.rejected, 1);
  assert.equal(m.feedback.quality_bug, 1);
  assert.equal(m.tags["format:xlsx"], 2);
});

test("신상품 프리셋: 카탈로그 ready 상품이 기존 엔진으로 동작", () => {
  const ready = CATALOG.filter((c) => c.status === "ready").map(toOffering);
  registerOfferings(ready);
  const r = fulfil("j", "email-list-clean", { data: "Name,Email\nKim,KIM@x.com\nKim2,kim@x.com\n" }, L);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(r.deliverable.text).summary.rowsOut, 1);
  assert.deepEqual(applyPreset({ operations: [{ op: "sort", by: "a" }] }, { operations: [{ op: "flatten" }], outputFormat: "csv" }), { operations: [{ op: "flatten" }, { op: "sort", by: "a" }], outputFormat: "csv" });
});

function fakeOps({ agents = [] } = {}) {
  const calls = [];
  return {
    calls,
    async address() { return "0xME"; },
    async browse() { return agents; },
    async listOfferings() { return [{ id: "o1", name: "Data Cleaning" }, { id: "o2", name: "Data Transform" }, { id: "o3", name: "Data Validation" }]; },
    async createOffering(o) { calls.push(["create", o.name, o.priceUsdc]); return { id: "new-" + o.service }; },
    async updateOfferingPrice(id, p) { calls.push(["price", id, p]); },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "growth-"));
  const store = new Store(dir);
  const cfg = { ...cfg0, offerings: JSON.parse(JSON.stringify(cfg0.offerings)) };
  return { store, cfg, guard: new Guard(store, cfg.policy), dir };
}

test("성장 사이클: 승인 없으면 출시·가격변경 보류, 승인 시 주 1개 출시", async () => {
  const { store, cfg, guard, dir } = setup();
  const ops = fakeOps();
  const r1 = await runGrowthCycle({ store, cfg, ops, guard, now: new Date("2026-03-01"), reportDir: join(dir, "g") });
  assert.match(r1.launch.result, /pending approval/);
  assert.equal(ops.calls.length, 0);
  guard.approve("auto-launch", "test");
  const r2 = await runGrowthCycle({ store, cfg, ops, guard, now: new Date("2026-03-02") });
  assert.equal(r2.launch.result, "launched");
  assert.equal(cfg.offerings.length, 4);
  const r3 = await runGrowthCycle({ store, cfg, ops, guard, now: new Date("2026-03-03") });
  assert.equal(r3.launch, null); // 주 1개 한도
  const r4 = await runGrowthCycle({ store, cfg, ops, guard, now: new Date("2026-03-10") });
  assert.equal(r4.launch.result, "launched");
  assert.equal(ops.calls.filter((c) => c[0] === "create").length, 2);
  assert.ok(r1.products.every((p) => p.priceResult === "unchanged")); // 주문·경쟁 데이터 없음 → 가격 유지
});

test("성장 사이클: 경쟁 저가 + 장기 무주문 → 가드 범위 내 인하, 하한 아래로는 절대 안 내려감", async () => {
  const { store, cfg, guard } = setup();
  guard.approve("price-change", "test");
  const agents = [{ name: "Cheap", walletAddress: "0xC", offerings: [{ name: "Data cleaning pro", description: "csv data cleaning", priceType: "fixed", priceValue: 0.01 }] }];
  const ops = fakeOps({ agents });
  let now = Date.parse("2026-04-01");
  for (let w = 0; w < 12; w++) {
    await runGrowthCycle({ store, cfg, ops, guard, now: new Date(now) });
    now += 7 * day;
  }
  const clean = cfg.offerings.find((o) => o.service === "data-clean");
  // 1단계(-10%) 인하 후, 주문 지표에 변화가 없으면 "가격이 원인이 아님"으로 보고 추가 인하 중단 (경쟁가 0.01 추종 안 함)
  assert.equal(clean.priceUsdc, 0.27);
  assert.equal(store.state.priceHistory.filter((h) => h.service === "data-clean").length, 1);
  assert.ok(store.state.priceHistory.every((h) => h.to >= 0.21));
  // 가격 불만이 계속 늘어나면(새 근거) 다음 인하가 가능하지만, 기준가 -30%(0.21) 하한 아래로는 절대 내려가지 않음
  for (let w = 0; w < 10; w++) {
    // 새 근거: 가격 불만이 매주 늘어남 (품질 문제 없음)
    for (let k = 0; k < 3 + w; k++) store.state.feedback.push({ at: new Date(now - day).toISOString(), service: "data-clean", source: "message", text: "too expensive" });
    await runGrowthCycle({ store, cfg, ops, guard, now: new Date(now) });
    now += 7 * day;
  }
  assert.equal(clean.priceUsdc, 0.21);
  assert.ok(store.state.priceHistory.every((h) => h.to >= 0.21));
});

test("성장 사이클: 거절 반복 → 보완 백로그, 가격 동결 / 모의 실행은 아무것도 바꾸지 않음", async () => {
  const { store, cfg, guard } = setup();
  guard.approve("price-change", "test");
  const at = "2026-05-05T00:00:00Z";
  for (let i = 0; i < 4; i++) store.state.jobs[i] = { service: "data-validate", status: i < 2 ? "rejected" : "completed", createdAt: at };
  store.state.feedback.push({ at, service: "data-validate", source: "rejection", text: "wrong result" });
  const ops = fakeOps();
  const r = await runGrowthCycle({ store, cfg, ops, guard, now: new Date("2026-05-07"), dryRun: true });
  const v = r.products.find((p) => p.service === "data-validate");
  assert.equal(v.decision, "patch");
  assert.equal(v.priceResult, "unchanged");
  assert.ok(r.backlog.some((b) => b.type === "patch" && b.service === "data-validate"));
  assert.equal(ops.calls.length, 0);
});

test("자산관리: 제안만 생성(승인 필요), 토큰발행·트레이딩 제안 없음", () => {
  const state = { ledger: Array.from({ length: 12 }, () => ({ type: "revenue", netUsdc: 2, at: new Date().toISOString() })), jobs: {}, wallet: { usdc: 30 } };
  const t = treasuryReport({ state, policy });
  assert.equal(t.availableUsdc, 28);
  assert.ok(t.proposals.length >= 4);
  assert.ok(t.proposals.every((p) => p.requiresApproval));
  assert.ok(!t.proposals.some((p) => /token|trade|트레이딩|토큰 발행|swap/i.test(p.title)));
});
