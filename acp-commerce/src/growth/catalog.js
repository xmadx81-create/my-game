// 신규 상품 카탈로그
// status "ready": 기존 엔진 + 프리셋만으로 동작하며 테스트가 끝나 자동 출시 가능 (AI 비용 0)
// status "needs-engine": 새 엔진 개발이 필요 → 주간 개선 작업(코드 변경) 백로그로 넘김
// keywords: 시장조사·수요신호와 매칭할 키워드

const DATA = { type: ["string", "array"], description: "CSV/TSV/JSON/JSONL text, or an array of objects" };

export const CATALOG = [
  {
    service: "email-list-clean",
    name: "Email List Cleaner",
    engine: "data-clean",
    preset: { options: { dedupeOnType: "email" } },
    status: "ready",
    priceUsdc: 0.15,
    slaMinutes: 10,
    keywords: ["email list", "mailing list", "email cleaning", "dedupe email", "newsletter", "lead list"],
    description: "Cleans a contact/lead list: lowercases and trims emails, removes duplicates by email address, normalizes names (unicode, spacing), phone numbers and dates, and lists invalid emails in 'issues' instead of guessing. Deterministic, self-QA + sha256. CSV/TSV/JSON/JSONL up to 1MB / 20,000 rows.",
    requirements: { type: "object", properties: { data: DATA, outputFormat: { type: "string", enum: ["csv", "tsv", "json", "jsonl"] } }, required: ["data"] },
    deliverable: "JSON: {notes, summary, changeSamples, issues (invalid emails), output:{format,rows,data}, qa, sha256}",
  },
  {
    service: "csv-to-json",
    name: "CSV to JSON Converter",
    engine: "data-transform",
    preset: { outputFormat: "json" },
    status: "ready",
    priceUsdc: 0.1,
    slaMinutes: 5,
    keywords: ["csv to json", "convert csv", "csv json", "format conversion", "spreadsheet to json"],
    description: "Fast, exact CSV/TSV to JSON conversion (RFC 4180 quotes, multiline cells, BOM). Optional operations (rename, select, cast, filter, sort). Deterministic, self-QA + sha256. Up to 1MB / 20,000 rows.",
    requirements: { type: "object", properties: { data: DATA, operations: { type: "array", maxItems: 50, items: { type: "object", required: ["op"] } } }, required: ["data"] },
    deliverable: "JSON: {summary, operationsLog, output:{format:'json',rows,data}, qa, sha256}",
  },
  {
    service: "json-flatten",
    name: "Nested JSON to CSV Flattener",
    engine: "data-transform",
    preset: { outputFormat: "csv", operations: [{ op: "flatten", separator: "." }] },
    status: "ready",
    priceUsdc: 0.15,
    slaMinutes: 5,
    keywords: ["flatten json", "nested json", "json to csv", "api response to csv", "json csv"],
    description: "Flattens nested JSON/JSONL (API responses, exports) into a clean CSV table with dot-path columns (user.address.city); arrays of scalars are joined with '|'. Deterministic, self-QA + sha256. Up to 1MB / 20,000 rows.",
    requirements: { type: "object", properties: { data: DATA, operations: { type: "array", maxItems: 50, items: { type: "object", required: ["op"] } } }, required: ["data"] },
    deliverable: "JSON: {summary, operationsLog, columns, output:{format:'csv',rows,data}, qa, sha256}",
  },
  // ---- 새 엔진이 필요한 후보 (주간 개선 작업에서 개발 → 테스트 후 status를 ready로 변경) ----
  { service: "schema-infer", name: "JSON Schema Generator", status: "needs-engine", keywords: ["json schema", "infer schema", "schema generation", "data contract"], priceUsdc: 0.2 },
  { service: "data-diff", name: "Dataset Diff", status: "needs-engine", keywords: ["diff", "compare datasets", "compare csv", "changes between files"], priceUsdc: 0.25 },
  { service: "pii-mask", name: "PII Masking", status: "needs-engine", keywords: ["pii", "mask", "redact", "anonymize", "gdpr"], priceUsdc: 0.3 },
  { service: "xlsx-convert", name: "Excel (XLSX) Converter", status: "needs-engine", keywords: ["xlsx", "excel", "spreadsheet"], priceUsdc: 0.25 },
];

/** 프리셋 적용: 프리셋 값이 기본, 구매자 요청이 일부 덮어씀 (operations는 프리셋 → 요청 순) */
export function applyPreset(req, preset = {}) {
  const out = { ...req };
  if (preset.options) out.options = { ...preset.options, ...(req.options || {}) };
  if (preset.outputFormat && !req.outputFormat) out.outputFormat = preset.outputFormat;
  if (preset.operations) out.operations = [...preset.operations, ...(Array.isArray(req.operations) ? req.operations : [])];
  return out;
}

/** 오퍼링 등록용 형식으로 변환 */
export function toOffering(c) {
  return { service: c.service, engine: c.engine, preset: c.preset, name: c.name, description: c.description, priceUsdc: c.priceUsdc, basePriceUsdc: c.priceUsdc, slaMinutes: c.slaMinutes, requirements: c.requirements, deliverable: c.deliverable, version: "1.0.0" };
}
