// 상품 1: 데이터 정제 (Data Cleaning)
// 공백·대소문자·헤더 정리, 결측 표준화, 중복 제거, 날짜/숫자/이메일/전화/불리언 표준화
import { loadTable, serialize, isBlank, parseDate, parseNumber, parseBoolean, inferType, EMAIL_RE, ServiceError, FORMATS } from "./common.js";

export const DEFAULT_CLEAN_OPTIONS = {
  trim: true,
  collapseWhitespace: true,
  normalizeHeaders: "snake", // "snake" | "keep"
  nullValues: ["", "n/a", "na", "null", "none", "-", "nan", "#n/a", "undefined"],
  dropEmptyRows: true,
  dropEmptyColumns: false,
  dedupe: true,
  dedupeKeys: null, // null → 전체 열 기준
  standardize: { dates: true, numbers: true, emails: true, phones: true, booleans: true },
};

export function toSnake(h) {
  const s = String(h)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return s || "column";
}

function normalizePhone(v) {
  const raw = String(v).trim();
  const digits = raw.replace(/[^\d+]/g, "");
  const d = digits.replace(/^\+/, "");
  if (d.length < 7 || d.length > 15) return null;
  // 한국 휴대폰/유선 (010-1234-5678, 02-123-4567)
  if (/^01[016789]\d{7,8}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^82(10\d{8})$/.test(d)) { const k = "0" + d.slice(2); return `${k.slice(0, 3)}-${k.slice(3, 7)}-${k.slice(7)}`; }
  if (/^02\d{7,8}$/.test(d)) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  if (/^0\d{2}\d{7,8}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return raw.startsWith("+") ? "+" + d : d;
}

const PHONE_HINT = /(phone|tel|mobile|cell|전화|연락처|휴대폰)/i;
const EMAIL_HINT = /(email|e_mail|mail|이메일)/i;
const DATE_HINT = /(date|day|_at$|_on$|time|dt$|일자|날짜|일시)/i;

export function runClean(req, limits) {
  const opts = mergeOptions(req.options);
  const table = loadTable(req.data, req.format, limits);
  const outputFormat = req.outputFormat || table.format;
  if (!FORMATS.includes(outputFormat)) throw new ServiceError("BAD_FORMAT", `지원하지 않는 출력 형식: ${outputFormat}`);

  const stats = { rowsIn: table.records.length, cellsTrimmed: 0, nullsStandardized: 0, datesStandardized: 0, numbersStandardized: 0, emailsLowercased: 0, invalidEmails: 0, invalidDates: 0, phonesStandardized: 0, booleansStandardized: 0, emptyRowsDropped: 0, duplicatesDropped: 0, emptyColumnsDropped: 0, headersRenamed: 0 };
  const nullSet = new Set(opts.nullValues.map((v) => String(v).toLowerCase()));

  // 1) 헤더 정리
  const headerMap = new Map();
  const usedNames = new Set();
  for (const c of table.columns) {
    let n = opts.normalizeHeaders === "snake" ? toSnake(c) : String(c).trim();
    let base = n, k = 2;
    while (usedNames.has(n)) n = `${base}_${k++}`;
    usedNames.add(n);
    headerMap.set(c, n);
    if (n !== c) stats.headersRenamed++;
  }
  let columns = table.columns.map((c) => headerMap.get(c));

  // 2) 셀 단위 정리
  let records = table.records.map((r) => {
    const o = {};
    for (const c of table.columns) {
      let v = r[c];
      if (typeof v === "string") {
        let nv = v;
        if (opts.trim) nv = nv.trim();
        if (opts.collapseWhitespace) nv = nv.replace(/[ \t 　]+/g, " ");
        if (nv !== v) stats.cellsTrimmed++;
        v = nv;
        if (nullSet.has(v.toLowerCase())) {
          if (v !== "") stats.nullsStandardized++;
          v = null;
        }
      } else if (v === undefined) v = null;
      o[headerMap.get(c)] = v;
    }
    return o;
  });

  // 3) 열 단위 표준화 (열 타입 추론 기반 → 혼합 열 오변환 방지)
  const columnTypes = {};
  for (const col of columns) {
    const values = records.map((r) => r[col]);
    const nonBlank = values.filter((v) => !isBlank(v));
    const s = opts.standardize;
    const ratio = (fn) => (nonBlank.length ? nonBlank.filter(fn).length / nonBlank.length : 0);
    let type = inferType(values);
    const dateRatio = ratio((v) => /\d/.test(String(v)) && parseDate(v) !== null);
    if (s.dates && type !== "date" && type !== "integer" && type !== "number" && (dateRatio >= 0.8 || (DATE_HINT.test(col) && dateRatio >= 0.5))) type = "date";
    if (s.phones && PHONE_HINT.test(col)) type = "phone";
    if (s.emails && (EMAIL_HINT.test(col) || type === "email")) type = "email";
    if (s.numbers && type === "string" && ratio((v) => parseNumber(v) !== null) >= 0.9) type = "number";
    if (s.booleans && type === "string" && ratio((v) => parseBoolean(v) !== null) === 1 && nonBlank.length) type = "boolean";
    columnTypes[col] = type;

    for (const r of records) {
      const v = r[col];
      if (isBlank(v)) continue;
      if (type === "date" && s.dates) {
        const d = parseDate(v);
        if (d && d !== v) (r[col] = d), stats.datesStandardized++;
        else if (!d) stats.invalidDates++; // 원본 유지 + 건수 보고 (임의 보정 금지)
      } else if ((type === "number" || type === "integer") && s.numbers && typeof v === "string") {
        const n = parseNumber(v);
        if (n !== null) (r[col] = n), stats.numbersStandardized++;
      } else if (type === "email" && s.emails) {
        const e = String(v).trim().toLowerCase();
        if (e !== v) stats.emailsLowercased++;
        r[col] = e;
        if (!EMAIL_RE.test(e)) stats.invalidEmails++;
      } else if (type === "phone" && s.phones) {
        const p = normalizePhone(v);
        if (p && p !== v) (r[col] = p), stats.phonesStandardized++;
      } else if (type === "boolean" && s.booleans && typeof v !== "boolean") {
        const b = parseBoolean(v);
        if (b !== null) (r[col] = b), stats.booleansStandardized++;
      }
    }
  }

  // 4) 빈 행 제거
  if (opts.dropEmptyRows) {
    const before = records.length;
    records = records.filter((r) => columns.some((c) => !isBlank(r[c])));
    stats.emptyRowsDropped = before - records.length;
  }

  // 5) 빈 열 제거
  if (opts.dropEmptyColumns) {
    const keep = columns.filter((c) => records.some((r) => !isBlank(r[c])));
    stats.emptyColumnsDropped = columns.length - keep.length;
    columns = keep;
  }

  // 6) 중복 제거 (첫 행 유지)
  if (opts.dedupe) {
    const keys = opts.dedupeKeys?.length ? opts.dedupeKeys.map((k) => (headerMap.get(k) ?? (opts.normalizeHeaders === "snake" ? toSnake(k) : k))) : columns;
    const missing = keys.filter((k) => !columns.includes(k));
    if (missing.length) throw new ServiceError("BAD_OPTION", `dedupeKeys에 없는 열: ${missing.join(", ")}`);
    const seen = new Set();
    const before = records.length;
    records = records.filter((r) => {
      const key = JSON.stringify(keys.map((k) => (typeof r[k] === "string" ? r[k].toLowerCase() : r[k])));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    stats.duplicatesDropped = before - records.length;
  }

  stats.rowsOut = records.length;
  const output = serialize(columns, records, outputFormat);
  return {
    summary: stats,
    columns,
    columnTypes,
    output: { format: outputFormat, rows: records.length, data: output },
  };
}

function mergeOptions(o = {}) {
  return {
    ...DEFAULT_CLEAN_OPTIONS,
    ...o,
    standardize: { ...DEFAULT_CLEAN_OPTIONS.standardize, ...(o.standardize || {}) },
    nullValues: o.nullValues ?? DEFAULT_CLEAN_OPTIONS.nullValues,
  };
}
