// 관제 지표 집계: 관리자 화면 표시 항목 전부를 state.json에서 계산
const FAILED = new Set(["failed", "rejected"]);
const DONE = new Set(["completed"]);

export function computeMetrics(state, { offerings, policy, candidates, now = new Date() }) {
  const jobs = Object.values(state.jobs);
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const r6 = (n) => +n.toFixed(6);

  const todayJobs = jobs.filter((j) => j.createdAt?.startsWith(today));
  const count = (list, pred) => list.filter(pred).length;

  const byProduct = {};
  for (const o of offerings) byProduct[o.service] = { name: o.name, priceUsdc: o.priceUsdc, orders: 0, completed: 0, failed: 0, declined: 0, grossUsdc: 0, netUsdc: 0, feeUsdc: 0 };
  for (const j of jobs) {
    const p = byProduct[j.service];
    if (!p) continue;
    p.orders++;
    if (DONE.has(j.status)) p.completed++;
    if (FAILED.has(j.status)) p.failed++;
    if (j.status === "declined") p.declined++;
  }
  const revenue = state.ledger.filter((l) => l.type === "revenue");
  for (const l of revenue) {
    const p = byProduct[l.service];
    if (p) (p.grossUsdc = r6(p.grossUsdc + l.grossUsdc)), (p.netUsdc = r6(p.netUsdc + l.netUsdc)), (p.feeUsdc = r6(p.feeUsdc + l.feeUsdc));
  }

  const monthRevenue = revenue.filter((l) => l.at.startsWith(month));
  const monthNet = r6(monthRevenue.reduce((a, l) => a + l.netUsdc, 0));
  const monthGross = r6(monthRevenue.reduce((a, l) => a + l.grossUsdc, 0));
  const aiCostMonth = r6(state.ledger.filter((l) => l.type === "cost" && l.category === "ai" && l.at.startsWith(month)).reduce((a, l) => a + l.usd, 0));
  const aiCostTotal = r6(state.ledger.filter((l) => l.type === "cost" && l.category === "ai").reduce((a, l) => a + l.usd, 0));
  const fixedMonth = policy.costs.monthlyFixedUsd || 0;

  // 월별 추이 (최근 6개월)
  const monthly = {};
  for (const l of revenue) {
    const m = l.at.slice(0, 7);
    monthly[m] = monthly[m] || { grossUsdc: 0, netUsdc: 0, orders: 0 };
    monthly[m].grossUsdc = r6(monthly[m].grossUsdc + l.grossUsdc);
    monthly[m].netUsdc = r6(monthly[m].netUsdc + l.netUsdc);
    monthly[m].orders++;
  }

  // 서비스 운영 상태
  const hb = state.heartbeat || {};
  const lastAt = hb.lastEventAt || hb.at;
  const ageSec = lastAt ? Math.round((now - new Date(lastAt)) / 1000) : null;
  const status = !hb.state ? "not_started" : hb.state === "stopped" ? "stopped" : ageSec !== null && ageSec > 3600 ? "idle" : "running";

  // 신규 사업 후보: 설정 후보 + 거절된 요청(수요 신호) 집계
  const signalCounts = {};
  for (const s of state.signals) {
    const k = `${s.kind}${s.code ? ":" + s.code : ""}`;
    signalCounts[k] = (signalCounts[k] || 0) + 1;
  }
  const processing = jobs.filter((j) => j.processingMs !== undefined).map((j) => j.processingMs);

  return {
    generatedAt: now.toISOString(),
    orders: {
      today: todayJobs.length,
      todayCompleted: count(todayJobs, (j) => DONE.has(j.status)),
      cumulative: jobs.length,
      completed: count(jobs, (j) => DONE.has(j.status)),
      failed: count(jobs, (j) => FAILED.has(j.status)),
      declined: count(jobs, (j) => j.status === "declined"),
      expired: count(jobs, (j) => j.status === "expired"),
      inProgress: count(jobs, (j) => ["open", "budget_set", "funded", "submitted"].includes(j.status)),
      successRate: (() => { const d = count(jobs, (j) => DONE.has(j.status)), f = count(jobs, (j) => FAILED.has(j.status)); return d + f ? +(d / (d + f)).toFixed(4) : null; })(),
      avgProcessingMs: processing.length ? Math.round(processing.reduce((a, b) => a + b, 0) / processing.length) : null,
    },
    revenueByProduct: byProduct,
    costs: { aiCostMonthUsd: aiCostMonth, aiCostTotalUsd: aiCostTotal, fixedMonthUsd: fixedMonth, protocolFeeRate: policy.protocolFeeRate },
    monthly: {
      month,
      grossUsdc: monthGross,
      netUsdc: monthNet,
      profitUsd: r6(monthNet - aiCostMonth - fixedMonth),
      history: monthly,
    },
    wallet: state.wallet,
    service: { status, adapter: hb.adapter || null, network: hb.network || null, address: hb.address || null, startedAt: hb.startedAt || null, lastEventAt: hb.lastEventAt || null, lastEventAgeSec: ageSec, offerings: offerings.map((o) => ({ name: o.name, service: o.service, priceUsdc: o.priceUsdc, slaMinutes: o.slaMinutes })) },
    approvals: state.approvals.filter((a) => !a.revokedAt),
    candidates: { planned: candidates, demandSignals: signalCounts, recentSignals: state.signals.slice(-10).reverse() },
    recentJobs: jobs.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 20).map((j) => ({ jobId: j.jobId, service: j.service, status: j.status, price: j.price, netUsdc: j.netUsdc, updatedAt: j.updatedAt, failReason: j.failReason })),
  };
}
