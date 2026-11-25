// 자산관리: 잔액·수익·비용 현황, 예비금 정책, 수익 증대 "제안"만 생성 (자동 지출·투자 없음)
// 개발 원칙: 관리자 승인 없는 지출·출금 금지 / 자체 토큰 발행·투기성 거래 금지 → 해당 제안은 생성하지 않는다

export const FORBIDDEN_STRATEGIES = ["자체 토큰 발행(tokenize)", "트레이딩·스왑·레버리지(acp trade)", "DeFi 이자농사·유동성 공급", "타 에이전트 토큰 매수"];

export function treasuryReport({ state, policy, now = new Date() }) {
  const month = now.toISOString().slice(0, 7);
  const rev = state.ledger.filter((l) => l.type === "revenue");
  const net = (list) => +list.reduce((a, l) => a + (l.netUsdc || 0), 0).toFixed(6);
  const balance = state.wallet?.usdc ?? 0;
  const t = policy.treasury || { reserveUsdc: 2, reserveMonths: 1 };
  const monthlyCost = (policy.costs?.monthlyFixedUsd || 0) + (policy.costs?.aiCostPerJobUsd || 0) * Object.keys(state.jobs).length;
  const reserve = Math.max(t.reserveUsdc, monthlyCost * t.reserveMonths);
  const available = +Math.max(0, balance - reserve).toFixed(6);

  const proposals = [];
  const add = (title, why, costUsdc, effect) => proposals.push({ title, why, costUsdc, expectedEffect: effect, requiresApproval: true });
  // 비용 0 성장안 (등록 승인만 필요)
  add("구독 패키지 출시 (예: 30일 50건 3 USDC)", "반복 구매 고객 확보·선불 매출", 0, "재구매율↑, 월 고정 매출");
  if (rev.length >= 10) add("Evaluator(결과물 검수) 대행 상품 출시", "검수 엔진 재사용, 타 에이전트 거래의 품질 검증 수요", 0, "신규 고객층");
  // 지출이 필요한 성장안 (가용 자금이 있을 때만 제안)
  if (available >= 1) add("ERC-8004 온체인 신원 등록", "신뢰도·평판 노출 → 구매 전환율 개선", "가스비(소액, 확인 필요)", "검색·평판 신뢰도↑");
  if (available >= 5) add("Bounty 보드 데이터 과제 응찰·홍보", "직접 수요 발굴", "건별 상이", "주문 유입 채널 추가");
  if (available >= 20) add("상시 운영 서버 비용 충당 (예: 소형 VPS)", "판매 중단 없는 24시간 운영", "월 수 USD(확인 필요)", "가동률↑ → 매출 기회↑");

  return {
    at: now.toISOString(),
    balanceUsdc: balance,
    reserveUsdc: reserve,
    availableUsdc: available,
    revenue: { monthNetUsdc: net(rev.filter((l) => l.at.startsWith(month))), totalNetUsdc: net(rev) },
    proposals,
    forbidden: FORBIDDEN_STRATEGIES,
    note: "모든 지출·출금은 관리자 승인 후 수동 실행. 자동 투자·트레이딩 경로 없음.",
  };
}
