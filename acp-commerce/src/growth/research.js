// 주간 시장조사: 마켓 스냅샷 수집 → 카테고리별 공급·가격·실적 추이 → 고객 니즈(미충족 요청) 분석 → 신상품 후보 점수화
import { MATCHERS } from "../core/pricing.js";

export const RESEARCH_QUERIES = [
  "data", "csv", "json", "excel", "data cleaning", "data validation", "data quality", "format conversion", "schema",
  "scraping", "extract", "parse", "pdf", "translation", "summarize", "research", "analysis", "report",
  "pii", "compliance", "audit", "swap", "trading", "signal", "content", "image",
];

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** acp browse 결과를 평탄화한 스냅샷 */
export function buildSnapshot(resultsByQuery, { at = new Date().toISOString(), excludeWallets = [] } = {}) {
  const ex = new Set(excludeWallets.map((w) => w.toLowerCase()));
  const seen = new Map();
  for (const [query, agents] of Object.entries(resultsByQuery)) {
    for (const a of agents || []) {
      if (ex.has(String(a.walletAddress || "").toLowerCase())) continue;
      for (const o of a.offerings || []) {
        if (o.isHidden) continue;
        const key = `${a.walletAddress}:${o.name}`;
        if (!seen.has(key)) seen.set(key, { agent: a.name, wallet: a.walletAddress, offering: o.name, description: (o.description || "").slice(0, 300), priceUsdc: Number(o.priceValue) || null, priceType: o.priceType, successfulJobCount: a.successfulJobCount ?? null, uniqueBuyerCount: a.uniqueBuyerCount ?? null, rating: a.rating ?? null, queries: [] });
        seen.get(key).queries.push(query);
      }
    }
  }
  return { at, queries: Object.keys(resultsByQuery), offerings: [...seen.values()] };
}

/** 스냅샷 분석: 쿼리(카테고리)별 공급자 수·가격 중앙값·실적 합계, 전주 대비 변화 */
export function analyzeMarket(snapshot, previous = null) {
  const cat = {};
  for (const o of snapshot.offerings) for (const q of o.queries) {
    const c = (cat[q] ??= { offerings: 0, prices: [], jobs: 0 });
    c.offerings++;
    if (o.priceUsdc) c.prices.push(o.priceUsdc);
    c.jobs += o.successfulJobCount || 0;
  }
  const prevCat = previous ? analyzeMarket(previous).categories : {};
  const categories = {};
  for (const [q, c] of Object.entries(cat)) categories[q] = { offerings: c.offerings, medianPriceUsdc: median(c.prices), totalSuccessfulJobs: c.jobs, deltaOfferings: prevCat[q] ? c.offerings - prevCat[q].offerings : null };
  return { totalOfferings: snapshot.offerings.length, categories, empty: snapshot.offerings.length === 0 };
}

/** 고객 니즈: 우리에게 들어온 미지원·형식오류 요청과 구매자 메시지에서 키워드 빈도 */
export function customerNeeds(state, { since }) {
  const texts = [];
  for (const s of state.signals || []) if (s.at >= since && ["unsupported_request", "invalid_request"].includes(s.kind)) texts.push(`${s.code || ""} ${s.detail || ""}`);
  for (const f of state.feedback || []) if (f.at >= since) texts.push(f.text || "");
  const words = {};
  for (const t of texts) for (const w of t.toLowerCase().match(/[a-z][a-z0-9+-]{2,}|[가-힣]{2,}/g) || []) {
    if (STOP.has(w)) continue;
    words[w] = (words[w] || 0) + 1;
  }
  return { samples: texts.slice(-10), topKeywords: Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 15) };
}
const STOP = new Set(["the", "and", "for", "with", "this", "that", "please", "request", "declined", "unsupported", "offering", "data", "column", "unknown", "invalid", "error"]);

/**
 * 신상품 후보 점수 (0~100)
 *  수요(우리 요청 신호·시장 실적) 40 + 경쟁 여지 20 + 엔진 재사용(즉시 출시 가능) 25 + AI 비용 0 15
 */
export function scoreCandidates(catalog, { market, needs, launchedServices = [] }) {
  const kw = Object.fromEntries(needs.topKeywords);
  return catalog
    .filter((c) => !launchedServices.includes(c.service))
    .map((c) => {
      const words = c.keywords.join(" ").toLowerCase().split(/\s+/);
      const demandSignal = words.reduce((a, w) => a + (kw[w] || 0), 0);
      const marketHits = market.empty ? 0 : market.categories ? Object.entries(market.categories).filter(([q]) => c.keywords.some((k) => k.includes(q) || q.includes(k))).reduce((a, [, v]) => a + v.totalSuccessfulJobs, 0) : 0;
      const competitors = market.empty ? 0 : Object.entries(market.categories).filter(([q]) => c.keywords.some((k) => k.includes(q))).reduce((a, [, v]) => a + v.offerings, 0);
      const demand = Math.min(40, demandSignal * 8 + Math.log10(1 + marketHits) * 8);
      const room = competitors === 0 ? 20 : Math.max(0, 20 - competitors * 2);
      const reuse = c.status === "ready" ? 25 : 5;
      const ai = 15;
      return { service: c.service, name: c.name, status: c.status, score: Math.round(demand + room + reuse + ai), detail: { demandSignal, marketHits, competitors } };
    })
    .sort((a, b) => b.score - a.score);
}

export { MATCHERS };
