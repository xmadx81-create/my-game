// 납품 전 자동 검수 (Self-QA): 결과물이 재파싱되는지, 행 수가 요약과 일치하는지, 크기 한도 이내인지 검증
import { loadTable, sha256 } from "./common.js";

export function qaCheck(service, result, { maxDeliverableBytes }) {
  const checks = [];
  const push = (name, passed, detail) => checks.push({ name, passed, ...(detail ? { detail } : {}) });

  if (service === "data-clean" || service === "data-transform") {
    const out = result.output;
    try {
      const reparsed = loadTable(out.data, out.format, { maxInputBytes: Infinity, maxRows: Infinity });
      push("output_reparse", true);
      push("row_count_match", reparsed.records.length === out.rows && out.rows === result.summary.rowsOut, `${reparsed.records.length}/${out.rows}`);
      const header = reparsed.columns;
      if (out.format === "csv" || out.format === "tsv") push("header_unique", new Set(header).size === header.length);
    } catch (e) {
      push("output_reparse", false, e.message);
    }
    if (service === "data-clean") push("rows_not_increased", result.summary.rowsOut <= result.summary.rowsIn);
  }
  if (service === "data-validate") {
    const s = result.summary;
    const sumByRule = Object.values(result.errorsByRule).reduce((a, b) => a + b, 0);
    push("error_count_consistent", sumByRule === s.errorCount, `${sumByRule}/${s.errorCount}`);
    push("score_in_range", s.qualityScore >= 0 && s.qualityScore <= 100);
    push("valid_flag_consistent", s.valid === (s.errorCount === 0));
  }
  const size = Buffer.byteLength(JSON.stringify(result));
  push("deliverable_size_limit", size <= maxDeliverableBytes, `${size}B / ${maxDeliverableBytes}B`);
  return { passed: checks.every((c) => c.passed), checks };
}

/** ACP 납품물(문자열) 생성: 결과 + 검수 + 해시. 구매자가 해시로 무결성 확인 가능 */
export function buildDeliverable({ jobId, service, version, result, qa }) {
  const body = { service, version, jobId, generatedAt: new Date().toISOString(), qa, ...result };
  const payload = JSON.stringify(body);
  return { text: JSON.stringify({ ...body, sha256: sha256(payload) }), sha256: sha256(payload) };
}
