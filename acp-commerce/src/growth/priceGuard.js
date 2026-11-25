// 가격 안전장치: 모든 가격 변경은 이 가드를 통과해야 한다.
// 무한 인하(가격 경쟁 바닥치기) 방지 규칙
//   1) 하한가: max(정책 하한, 원가 기반 하한) — 수수료·AI비용 차감 후 최소 마진 보장
//   2) 상한가: 기준가 × maxMultiplier
//   3) 1회 변동폭: ±maxStepRate (기본 10%)
//   4) 쿨다운: 마지막 변경 후 cooldownDays 이내 재변경 금지
//   5) 누적 인하 한도: 기준가 대비 maxDrawdownRate(기본 30%) 이상 인하 금지
//   6) 연속 인하 금지: 직전 변경이 인하였다면, 새로운 근거(주문 지표 변화)가 없는 한 추가 인하 금지

export const DEFAULT_GUARD = {
  floorUsdc: 0.05,
  minNetMarginUsdc: 0.03, // 수수료·AI비 차감 후 건당 최소 순이익
  maxStepRate: 0.1,
  maxMultiplier: 2.0,
  maxDrawdownRate: 0.3,
  cooldownDays: 7,
};

const r2 = (n) => Math.round(n * 100 + 1e-9) / 100;

/** 원가 기반 하한: (AI비 + 최소 순이익) / (1 - 수수료율) */
export function costFloor({ protocolFeeRate, aiCostPerJobUsd = 0 }, g = DEFAULT_GUARD) {
  return Math.ceil(((aiCostPerJobUsd + g.minNetMarginUsdc) / (1 - protocolFeeRate)) * 100 - 1e-9) / 100;
}

export function bounds(product, policy, g = { ...DEFAULT_GUARD, ...(policy.priceGuard || {}) }) {
  const base = product.basePriceUsdc ?? product.priceUsdc;
  const floor = Math.max(g.floorUsdc, costFloor({ protocolFeeRate: policy.protocolFeeRate, aiCostPerJobUsd: policy.costs?.aiCostPerJobUsd ?? 0 }, g), r2(base * (1 - g.maxDrawdownRate)));
  const ceiling = r2(base * g.maxMultiplier);
  return { base, floor: r2(floor), ceiling };
}

/**
 * 요청 가격을 가드 규칙으로 보정한다.
 * @param product {service, priceUsdc, basePriceUsdc}
 * @param requested 원하는 가격
 * @param history [{service, at, from, to, reason}] 가격 변경 이력
 * @returns {priceUsdc, changed, applied: [규칙], blocked?: 사유}
 */
export function guardPrice({ product, requested, history = [], policy, now = new Date(), evidenceChanged = true, g = { ...DEFAULT_GUARD, ...(policy.priceGuard || {}) } }) {
  const cur = product.priceUsdc;
  const { floor, ceiling } = bounds(product, policy, g);
  const mine = history.filter((h) => h.service === product.service).sort((a, b) => a.at.localeCompare(b.at));
  const last = mine[mine.length - 1];
  const applied = [];

  if (last && (now - new Date(last.at)) / 86400e3 < g.cooldownDays) {
    return { priceUsdc: cur, changed: false, blocked: `cooldown: last change ${last.at.slice(0, 10)} (< ${g.cooldownDays} days)`, applied };
  }
  let p = requested;
  if (p < cur && last && last.to < last.from && !evidenceChanged) {
    return { priceUsdc: cur, changed: false, blocked: "consecutive decrease without new evidence", applied };
  }
  const maxUp = r2(cur * (1 + g.maxStepRate));
  const maxDown = r2(cur * (1 - g.maxStepRate));
  if (p > maxUp) (p = maxUp), applied.push(`step cap +${g.maxStepRate * 100}%`);
  if (p < maxDown) (p = maxDown), applied.push(`step cap -${g.maxStepRate * 100}%`);
  if (p < floor) (p = floor), applied.push(`floor ${floor}`);
  if (p > ceiling) (p = ceiling), applied.push(`ceiling ${ceiling}`);
  p = r2(p);
  return { priceUsdc: p, changed: p !== cur, applied, floor, ceiling };
}
