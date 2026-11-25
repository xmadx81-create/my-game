// 성장 사이클이 사용하는 ACP 조작 인터페이스 (실거래: 공식 acp-cli 경유)
// 자금 이동 명령(송금·충전·출금·트레이딩·토큰발행)은 의도적으로 포함하지 않는다.

export function cliOps(adapter) {
  const run = (args) => adapter.run(args, { timeoutMs: 180_000 });
  return {
    async address() { return (await run(["wallet", "address"])).address ?? null; },
    async browse(query) { const r = await run(["browse", query, "--top-k", "25"]); return r.data || []; },
    async listOfferings() { const r = await run(["offering", "list"]); return Array.isArray(r) ? r : r.data || []; },
    async createOffering(o) {
      return run(["offering", "create", "--name", o.name, "--description", o.description, "--price-type", "fixed", "--price-value", o.priceUsdc.toFixed(2), "--sla-minutes", String(o.slaMinutes), "--requirements", JSON.stringify(o.requirements), "--deliverable", o.deliverable, "--no-required-funds", "--no-hidden"]);
    },
    async updateOfferingPrice(id, priceUsdc) { return run(["offering", "update", "--offering-id", id, "--price-value", priceUsdc.toFixed(2)]); },
  };
}
