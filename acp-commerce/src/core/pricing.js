// 경쟁 가격 연동: 유사 상품이 있으면 최저가보다 약간 낮게(기본 10%), 단 하한가(floor) 미만으로는 내리지 않음
// 원칙: 유사 상품이 없으면 현재 가격 유지 (근거 없는 인하 금지)

/** 서비스별 유사 상품 판별 규칙 (상품명+설명 기준) */
export const MATCHERS = {
  "data-clean": /(data\s*clean|clean(ing|up)?\s+(csv|data|table|dataset)|dedup|normaliz)/i,
  "data-transform": /(data\s*transform|format\s*conver|csv\s*(to|->)\s*json|json\s*(to|->)\s*csv|etl|reshap)/i,
  "data-validate": /(data\s*validat|data\s*quality|schema\s*validat|data\s*audit|validat(e|ion)\s+(csv|data|dataset))/i,
};

/** acp browse 결과(agents[])에서 서비스와 유사한 고정가 상품만 추출 */
export function findComparable(agents, service, { excludeWallets = [] } = {}) {
  const re = MATCHERS[service];
  const exclude = new Set(excludeWallets.map((w) => String(w).toLowerCase()));
  const out = [];
  for (const a of agents || []) {
    if (exclude.has(String(a.walletAddress || "").toLowerCase())) continue;
    for (const o of a.offerings || []) {
      if (o.isHidden) continue;
      const price = Number(o.priceValue);
      if (o.priceType && o.priceType !== "fixed") continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!re.test(`${o.name} ${o.description || ""}`)) continue;
      out.push({ agent: a.name, wallet: a.walletAddress, offering: o.name, priceUsdc: price, successfulJobCount: a.successfulJobCount ?? null });
    }
  }
  return out.sort((x, y) => x.priceUsdc - y.priceUsdc);
}

const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;

/** 제안 가격 계산 */
export function proposePrice({ currentUsdc, comparable, undercutRate = 0.1, floorUsdc = 0.05 }) {
  if (!comparable.length) return { priceUsdc: currentUsdc, changed: false, reason: "No comparable offering found; keeping current price" };
  const lowest = comparable[0].priceUsdc;
  const target = floor2(lowest * (1 - undercutRate));
  if (target < floorUsdc) {
    const price = Math.max(floorUsdc, currentUsdc <= floorUsdc ? currentUsdc : floorUsdc);
    return { priceUsdc: price, changed: price !== currentUsdc, reason: `Lowest competitor ${lowest} USDC is below our floor; holding floor ${floorUsdc} USDC`, lowestCompetitorUsdc: lowest };
  }
  return { priceUsdc: target, changed: target !== currentUsdc, reason: `${Math.round(undercutRate * 100)}% below lowest comparable offering (${lowest} USDC)`, lowestCompetitorUsdc: lowest };
}
