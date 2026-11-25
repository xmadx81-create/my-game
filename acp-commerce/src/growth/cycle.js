// 주간 성장 사이클 (자율 운영 루프)
//  1) 시장조사 스냅샷  2) 고객 니즈 분석  3) 상품별 피드백 판단(보완/업그레이드/성장/유지)
//  4) 가격 조정(가드 통과 + 'price-change' 승인 시 적용)  5) 신상품 자동 출시(카탈로그 ready + 'auto-launch' 승인, 주 1개 한도)
//  6) 개선 백로그 갱신(코드 변경은 주간 개선 작업에서 처리)  7) 자산관리 보고·제안  8) 보고서 저장
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_QUERIES, buildSnapshot, analyzeMarket, customerNeeds, scoreCandidates } from "./research.js";
import { collect, decide } from "./feedback.js";
import { guardPrice, bounds } from "./priceGuard.js";
import { findComparable } from "../core/pricing.js";
import { CATALOG, toOffering } from "./catalog.js";
import { treasuryReport } from "./treasury.js";
import { registerOfferings } from "../services/index.js";

const r2 = (n) => Math.round(n * 100 + 1e-9) / 100;
const cmpVer = (a = "1.0.0", b = "1.0.0") => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

export async function runGrowthCycle({ store, cfg, ops, guard, now = new Date(), dryRun = false, log = () => {}, offeringsPath = null, reportDir = null }) {
  const state = store.state;
  const policy = cfg.policy;
  const gp = policy.growth || {};
  const actions = [];

  // 1) 시장조사
  const me = (await ops.address().catch(() => null))?.toLowerCase();
  const results = {};
  const errors = [];
  for (const q of gp.researchQueries || RESEARCH_QUERIES) {
    try { results[q] = await ops.browse(q); } catch (e) { errors.push(`${q}: ${String(e.message).split("\n")[0]}`); }
  }
  const snapshot = buildSnapshot(results, { at: now.toISOString(), excludeWallets: me ? [me] : [] });
  const prevSnap = state.marketSnapshot || null;
  const market = analyzeMarket(snapshot, prevSnap);
  state.marketSnapshot = snapshot;
  const allAgents = Object.values(results).flat();

  // 2) 고객 니즈
  const since28 = new Date(now - 28 * 86400e3).toISOString();
  const needs = customerNeeds(state, { since: since28 });

  // 3)~4) 상품별 판단 + 가격
  const metrics = collect(state, { now });
  const lastCycle = (state.growth || []).at(-1);
  state.versions ??= {};
  state.backlog ??= [];
  const products = [];
  let liveOfferings = null;
  for (const p of cfg.offerings) {
    p.basePriceUsdc ??= p.priceUsdc;
    const m = metrics[p.service] || { orders: 0, completed: 0, rejected: 0, failed: 0, declined: 0, feedback: { quality_bug: 0, price: 0, speed: 0, praise: 0, feature_request: 0 }, tags: {}, samples: [], lastOrderAt: null };
    const comparable = findComparable(allAgents, p.engine || p.service, { excludeWallets: me ? [me] : [] });
    const competitorLowest = comparable[0]?.priceUsdc ?? null;
    const recordedVer = state.versions[p.service];
    const upgradeShipped = !!recordedVer && cmpVer(p.version, recordedVer) > 0 && p.changeType === "upgrade";
    state.versions[p.service] = p.version || "1.0.0";
    const d = decide(p.service, m, { competitorLowest, currentPrice: p.priceUsdc, upgradeShipped, now });

    let requested = p.priceUsdc;
    if (d.priceAction === "increase") requested = p.priceUsdc * 1.1;
    if (d.priceAction === "decrease") requested = Math.min(p.priceUsdc * 0.9, competitorLowest ? competitorLowest * 0.9 : Infinity);
    const prevM = lastCycle?.products?.find((x) => x.service === p.service)?.metrics;
    const evidenceChanged = !prevM || JSON.stringify(prevM) !== JSON.stringify({ orders: m.orders, completed: m.completed, rejected: m.rejected, price: m.feedback.price });
    const g = d.priceAction === "hold" ? { priceUsdc: p.priceUsdc, changed: false } : guardPrice({ product: p, requested: r2(requested), history: state.priceHistory || [], policy, now, evidenceChanged });

    let priceResult = "unchanged";
    if (g.changed) {
      if (dryRun) priceResult = `would change ${p.priceUsdc} → ${g.priceUsdc} (dry-run)`;
      else if (!guard.isApproved("price-change")) priceResult = `pending approval: ${p.priceUsdc} → ${g.priceUsdc}`;
      else {
        liveOfferings ??= await ops.listOfferings();
        const live = liveOfferings.find((x) => x.name === p.name);
        if (live) {
          await ops.updateOfferingPrice(live.id, g.priceUsdc);
          state.priceHistory.push({ service: p.service, at: now.toISOString(), from: p.priceUsdc, to: g.priceUsdc, reason: d.reasons.join("; "), decision: d.decision });
          actions.push(`price ${p.service}: ${p.priceUsdc} → ${g.priceUsdc} (${d.decision})`);
          priceResult = `changed ${p.priceUsdc} → ${g.priceUsdc}`;
          p.priceUsdc = g.priceUsdc;
        } else priceResult = "offering not found on marketplace";
      }
    } else if (g.blocked) priceResult = `blocked by guard: ${g.blocked}`;

    for (const b of d.backlog) if (!state.backlog.some((x) => x.title === b.title && x.service === b.service && !x.doneAt)) state.backlog.push({ ...b, createdAt: now.toISOString() });
    products.push({ service: p.service, name: p.name, priceUsdc: p.priceUsdc, bounds: bounds(p, policy), decision: d.decision, priceAction: d.priceAction, priceResult, reasons: d.reasons, competitorLowest, metrics: { orders: m.orders, completed: m.completed, rejected: m.rejected, price: m.feedback.price } });
  }

  // 5) 신상품
  const launchedServices = cfg.offerings.map((o) => o.service);
  const candidates = scoreCandidates(CATALOG, { market, needs, launchedServices });
  const weekAgo = new Date(now - 7 * 86400e3).toISOString();
  const launchedThisWeek = (state.launched || []).filter((l) => l.at >= weekAgo).length;
  const pick = candidates.find((c) => c.status === "ready" && c.score >= (gp.minLaunchScore ?? 50));
  let launch = null;
  if (pick && launchedThisWeek < (gp.maxLaunchesPerWeek ?? 1)) {
    const offering = toOffering(CATALOG.find((c) => c.service === pick.service));
    if (dryRun) launch = { service: pick.service, result: "would launch (dry-run)" };
    else if (!guard.isApproved("auto-launch")) launch = { service: pick.service, result: "pending approval (auto-launch)" };
    else {
      const r = await ops.createOffering(offering);
      cfg.offerings.push(offering);
      registerOfferings([offering]);
      state.launched.push({ service: offering.service, name: offering.name, id: r?.id ?? null, priceUsdc: offering.priceUsdc, at: now.toISOString(), score: pick.score });
      if (offeringsPath) writeFileSync(offeringsPath, JSON.stringify(cfg.offerings, null, 2) + "\n");
      actions.push(`launched ${offering.name} at ${offering.priceUsdc} USDC (score ${pick.score})`);
      launch = { service: pick.service, result: "launched", id: r?.id ?? null };
    }
  }
  for (const c of candidates.filter((c) => c.status === "needs-engine").slice(0, 2)) {
    const title = `Build engine: ${c.name}`;
    if (!state.backlog.some((x) => x.title === title && !x.doneAt)) state.backlog.push({ type: "new-engine", service: c.service, title, score: c.score, createdAt: now.toISOString() });
  }
  if (offeringsPath && actions.some((a) => a.startsWith("price"))) writeFileSync(offeringsPath, JSON.stringify(cfg.offerings, null, 2) + "\n");

  // 7) 자산관리
  const treasury = treasuryReport({ state, policy, now });

  // 8) 보고
  const report = { at: now.toISOString(), dryRun, market: { ...market, errors, queries: Object.keys(results).length }, needs, products, candidates: candidates.slice(0, 6), launch, backlog: state.backlog.filter((b) => !b.doneAt), treasury, actions };
  if (!dryRun) {
    state.growth.push({ at: report.at, products: products.map((p) => ({ service: p.service, decision: p.decision, priceUsdc: p.priceUsdc, metrics: p.metrics })), actions, launch });
    if (state.growth.length > 52) state.growth = state.growth.slice(-52);
  }
  store.save();
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `growth-${report.at.slice(0, 10)}.md`), toMarkdown(report));
    writeFileSync(join(reportDir, `growth-latest.json`), JSON.stringify(report, null, 2));
  }
  log(`[growth] cycle done: ${actions.length} action(s)`);
  return report;
}

export function toMarkdown(r) {
  const L = [];
  L.push(`# 주간 성장 보고 (${r.at.slice(0, 10)})${r.dryRun ? " [모의 실행]" : ""}`, "");
  L.push("## 1. 실행 결과", "", r.actions.length ? r.actions.map((a) => `- ${a}`).join("\n") : "- 자동 조치 없음", "");
  L.push("## 2. 상품별 판단 (보완·업그레이드·성장·유지)", "", "| 상품 | 판단 | 가격 방향 | 가격 결과 | 허용 범위 | 근거 |", "|---|---|---|---|---|---|");
  for (const p of r.products) L.push(`| ${p.name} | ${p.decision} | ${p.priceAction} | ${p.priceResult} | ${p.bounds.floor}~${p.bounds.ceiling} | ${p.reasons.join("; ")} |`);
  L.push("", "## 3. 시장조사", "", `- 수집 상품 수: ${r.market.totalOfferings} (검색어 ${r.market.queries}개${r.market.errors.length ? `, 오류 ${r.market.errors.length}건` : ""})`);
  if (r.market.empty) L.push("- 마켓 검색 결과 0건 → 경쟁가 비교 불가, 가격 인하 근거 없음");
  for (const [q, c] of Object.entries(r.market.categories).slice(0, 15)) L.push(`- ${q}: 공급 ${c.offerings} / 가격 중앙값 ${c.medianPriceUsdc ?? "-"} / 누적 실적 ${c.totalSuccessfulJobs}${c.deltaOfferings !== null ? ` / 전주 대비 ${c.deltaOfferings >= 0 ? "+" : ""}${c.deltaOfferings}` : ""}`);
  L.push("", "## 4. 고객 니즈 (최근 28일)", "", r.needs.topKeywords.length ? r.needs.topKeywords.map(([w, n]) => `- ${w}: ${n}`).join("\n") : "- 수집된 요청·의견 없음", "");
  L.push("## 5. 신상품 후보", "", "| 후보 | 상태 | 점수 |", "|---|---|---|", ...r.candidates.map((c) => `| ${c.name} | ${c.status} | ${c.score} |`), "", `- 이번 주 출시: ${r.launch ? `${r.launch.service} → ${r.launch.result}` : "없음"}`, "");
  L.push("## 6. 개선 백로그 (코드 작업 필요)", "", r.backlog.length ? r.backlog.map((b) => `- [${b.type}] ${b.title}${b.service ? ` (${b.service})` : ""}`).join("\n") : "- 없음", "");
  const t = r.treasury;
  L.push("## 7. 자산관리", "", `- 잔액 ${t.balanceUsdc} USDC / 예비금 ${t.reserveUsdc} / 가용 ${t.availableUsdc}`, `- 이번 달 순매출 ${t.revenue.monthNetUsdc} USDC, 누적 ${t.revenue.totalNetUsdc} USDC`, "", "| 제안 (모두 관리자 승인 필요) | 이유 | 비용 | 기대효과 |", "|---|---|---|---|", ...t.proposals.map((p) => `| ${p.title} | ${p.why} | ${p.costUsdc} | ${p.expectedEffect} |`), "", `- 제외(개발원칙): ${t.forbidden.join(", ")}`, "");
  return L.join("\n");
}
