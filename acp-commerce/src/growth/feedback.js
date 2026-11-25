// 구매자 피드백 엔진
// 수집원: 구매자 채팅 메시지, 거절(reject) 사유, 사전 거절된 요청(미지원·형식오류), 처리 실패
// 판단: 상품별로 "보완(patch)" / "업그레이드(upgrade)" / "성장(grow)" / "유지(hold)" 결정 + 가격 방향

export const CATEGORIES = [
  { key: "quality_bug", re: /(wrong|incorrect|broken|bug|mismatch|missing row|corrupt|garbled|not (cleaned|correct)|틀렸|오류|잘못|깨짐|누락)/i },
  { key: "price", re: /(expensive|too much|cheaper|lower (the )?price|overpriced|비싸|가격.*(높|내려))/i },
  { key: "speed", re: /(slow|took too long|late|timeout|느리|늦)/i },
  { key: "praise", re: /(great|perfect|excellent|thanks|thank you|good job|awesome|좋아|감사|훌륭)/i },
];

/** 기능·형식 요청 태그 추출 (같은 태그가 반복되면 업그레이드 후보) */
const FEATURE_TAGS = [
  ["format:xlsx", /(xlsx|excel|엑셀)/i],
  ["format:parquet", /parquet/i],
  ["format:xml", /\bxml\b/i],
  ["format:yaml", /\bya?ml\b/i],
  ["format:sql", /\bsql\b/i],
  ["feature:pii-masking", /(pii|mask|anonymi|redact|개인정보|마스킹)/i],
  ["feature:dedupe-fuzzy", /(fuzzy|similar (rows|names)|near.?duplicate|유사 중복)/i],
  ["feature:schema-infer", /(infer (the )?schema|json schema|스키마 (추론|생성))/i],
  ["feature:diff", /(diff|compare (two|datasets|files)|비교)/i],
  ["feature:large-files", /(larger|bigger|more than 20,?000|over 1 ?mb|대용량)/i],
  ["feature:translate", /(translat|번역)/i],
];

export function classify(text = "") {
  const cats = CATEGORIES.filter((c) => c.re.test(text)).map((c) => c.key);
  const tags = FEATURE_TAGS.filter(([, re]) => re.test(text)).map(([t]) => t);
  if (tags.length && !cats.includes("feature_request")) cats.push("feature_request");
  return { categories: cats, tags };
}

/** 사전 거절·실패 코드에서 기능 태그 추정 (예: 지원하지 않는 형식 → format 요청) */
function tagsFromCode(code, detail = "") {
  const t = classify(detail).tags;
  if (code === "UNSUPPORTED") t.push("new-product:" + (detail.match(/offering "([^"]+)"/)?.[1] || "unknown").toLowerCase());
  if (code === "TOO_LARGE" || code === "TOO_MANY_ROWS") t.push("feature:large-files");
  return t;
}

/** store 상태에서 최근 windowDays 동안의 상품별 지표·피드백 집계 */
export function collect(state, { now = new Date(), windowDays = 7, tagWindowDays = 28 } = {}) {
  const since = new Date(now - windowDays * 86400e3).toISOString();
  const tagSince = new Date(now - tagWindowDays * 86400e3).toISOString();
  const per = {};
  const get = (s) => (per[s] ??= { orders: 0, completed: 0, rejected: 0, failed: 0, declined: 0, feedback: { quality_bug: 0, price: 0, speed: 0, praise: 0, feature_request: 0 }, tags: {}, samples: [], lastOrderAt: null });
  for (const j of Object.values(state.jobs)) {
    const s = j.service || "unknown";
    const p = get(s);
    if (j.createdAt > (p.lastOrderAt || "")) p.lastOrderAt = j.createdAt;
    if (j.createdAt < since) continue;
    p.orders++;
    if (j.status === "completed") p.completed++;
    if (j.status === "rejected") p.rejected++;
    if (j.status === "failed") p.failed++;
    if (j.status === "declined") p.declined++;
  }
  for (const f of state.feedback || []) {
    const p = get(f.service || "unknown");
    const { categories, tags } = classify(f.text || "");
    if (f.at >= since) for (const c of categories) p.feedback[c] = (p.feedback[c] || 0) + 1;
    if (f.at >= since && f.source === "rejection" && !categories.includes("quality_bug")) p.feedback.quality_bug++; // 거절은 품질 신호로 본다
    if (f.at >= tagSince) for (const t of tags) p.tags[t] = (p.tags[t] || 0) + 1;
    if (f.at >= since && p.samples.length < 5 && f.text) p.samples.push(`[${f.source}] ${f.text.slice(0, 140)}`);
  }
  for (const s of state.signals || []) {
    if (!["invalid_request", "unsupported_request", "processing_failed"].includes(s.kind) || s.at < tagSince) continue;
    const p = get(s.service || "unknown");
    for (const t of tagsFromCode(s.code, s.detail)) p.tags[t] = (p.tags[t] || 0) + 1;
  }
  return per;
}

/**
 * 상품별 개선 방향·가격 방향 결정
 * - 보완(patch): 기존 기능의 결함(거절·실패·품질 불만) → 고친다. 가격은 동결 (품질 문제를 가격 인하로 덮지 않음)
 * - 업그레이드(upgrade): 같은 기능·형식 요청 반복(28일 내 3회 이상) → 기능 추가. 출시 후 가격 1단계 인상 허용
 * - 성장(grow): 주 20건 이상 + 성공률 95% 이상 + 가격 불만 없음 → 가격 1단계 인상
 * - 인하: 14일간 주문 0건이면서 경쟁 상품이 더 쌈, 또는 가격 불만 3회 이상(품질 문제 없음) → 1단계 인하 (가드 적용)
 */
export function decide(service, m, { competitorLowest = null, currentPrice, upgradeShipped = false, now = new Date() } = {}) {
  const reasons = [];
  const backlog = [];
  const issues = m.rejected + m.failed;
  const issueRate = m.orders ? issues / m.orders : 0;
  const repeated = Object.entries(m.tags).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

  if ((issues >= 2 && issueRate >= 0.2) || m.feedback.quality_bug >= 2) {
    reasons.push(`quality issues: ${issues} rejected/failed of ${m.orders} orders, ${m.feedback.quality_bug} quality complaints`);
    backlog.push({ type: "patch", service, title: "Fix defects reported by buyers", evidence: m.samples });
    return { decision: "patch", priceAction: "hold", reasons, backlog };
  }
  if (upgradeShipped) {
    reasons.push("upgrade shipped (new capability) → one-step price increase allowed");
    return { decision: "upgrade-shipped", priceAction: "increase", reasons, backlog };
  }
  if (repeated.length) {
    for (const [tag, n] of repeated) backlog.push({ type: tag.startsWith("new-product:") ? "new-product" : "upgrade", service, title: `Requested ${n}x: ${tag}`, tag, count: n });
    reasons.push(`repeated requests: ${repeated.map(([t, n]) => `${t}×${n}`).join(", ")}`);
    return { decision: "upgrade", priceAction: "hold", reasons, backlog };
  }
  const successRate = m.completed + issues ? m.completed / (m.completed + issues) : null;
  if (m.completed >= 20 && successRate >= 0.95 && m.feedback.price === 0) {
    reasons.push(`strong demand: ${m.completed} completed, success ${(successRate * 100).toFixed(0)}%`);
    return { decision: "grow", priceAction: "increase", reasons, backlog };
  }
  const idleDays = m.lastOrderAt ? (now - new Date(m.lastOrderAt)) / 86400e3 : Infinity;
  if (m.feedback.price >= 3) {
    reasons.push(`${m.feedback.price} price complaints without quality issues`);
    return { decision: "hold", priceAction: "decrease", reasons, backlog };
  }
  if (idleDays >= 14 && competitorLowest !== null && competitorLowest < currentPrice) {
    reasons.push(`no orders for ${Number.isFinite(idleDays) ? Math.floor(idleDays) : "14+"} days and a cheaper competitor (${competitorLowest} USDC)`);
    return { decision: "hold", priceAction: "decrease", reasons, backlog };
  }
  reasons.push(idleDays >= 14 ? "no orders yet, but no cheaper competitor found → keep price (no blind discounting)" : "stable");
  return { decision: "hold", priceAction: "hold", reasons, backlog };
}
