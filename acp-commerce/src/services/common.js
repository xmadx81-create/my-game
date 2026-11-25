// 공통 유틸: CSV/TSV/JSON/JSONL 파싱·직렬화, 입력 정규화, 해시
// 외부 의존성 없음 (Node.js 내장 모듈만 사용) → AI 호출비용 0, 설치비용 0
import { createHash } from "node:crypto";

export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const FORMATS = ["csv", "tsv", "json", "jsonl"];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** RFC 4180 호환 구분자 파서 (따옴표, 이스케이프된 따옴표, 개행 포함 셀 지원) */
export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM 제거
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (inQuotes) throw new ServiceError("PARSE_ERROR", "닫히지 않은 따옴표가 있습니다 (CSV 형식 오류)");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // 완전히 빈 마지막 줄 제거
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (rows.length === 0) return { columns: [], records: [] };
  const columns = uniqueHeaders(rows[0].map((h) => h.trim()));
  const records = rows.slice(1).map((r) => {
    const obj = {};
    columns.forEach((c, idx) => (obj[c] = r[idx] ?? ""));
    if (r.length > columns.length) obj.__extra = r.slice(columns.length).join(delimiter);
    return obj;
  });
  return { columns, records };
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((h, i) => {
    let name = h || `column_${i + 1}`;
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      name = `${name}_${n}`;
    } else seen.set(name, 1);
    return name;
  });
}

function escapeCell(value, delimiter) {
  if (value === null || value === undefined) return "";
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (s.includes('"') || s.includes(delimiter) || s.includes("\n") || s.includes("\r")) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toDelimited(columns, records, delimiter = ",") {
  const lines = [columns.map((c) => escapeCell(c, delimiter)).join(delimiter)];
  for (const r of records) lines.push(columns.map((c) => escapeCell(r[c], delimiter)).join(delimiter));
  return lines.join("\n") + "\n";
}

export function detectFormat(text) {
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      const firstLine = t.split(/\r?\n/)[0];
      try {
        JSON.parse(firstLine);
        return "jsonl";
      } catch {
        /* fallthrough */
      }
    }
  }
  const firstLine = t.split(/\r?\n/)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? "tsv" : "csv";
}

function columnsFromRecords(records) {
  const cols = [];
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return cols;
}

/**
 * 입력 데이터를 표 형태 {columns, records, format} 로 정규화.
 * data: 문자열(CSV/TSV/JSON/JSONL) 또는 객체 배열
 */
export function loadTable(data, format = "auto", limits = {}) {
  const { maxInputBytes = 1_000_000, maxRows = 20_000 } = limits;
  if (data === undefined || data === null) throw new ServiceError("MISSING_DATA", "data 필드가 비어 있습니다");
  let fmt = format || "auto";
  let columns;
  let records;
  if (Array.isArray(data)) {
    const size = Buffer.byteLength(JSON.stringify(data));
    if (size > maxInputBytes) throw new ServiceError("TOO_LARGE", `입력 크기 ${size}B가 한도 ${maxInputBytes}B를 초과합니다`);
    records = data.map((r, i) => {
      if (r === null || typeof r !== "object" || Array.isArray(r))
        throw new ServiceError("BAD_RECORD", `${i + 1}번째 항목이 객체가 아닙니다`);
      return { ...r };
    });
    columns = columnsFromRecords(records);
    fmt = "json";
  } else if (typeof data === "string") {
    const size = Buffer.byteLength(data);
    if (size > maxInputBytes) throw new ServiceError("TOO_LARGE", `입력 크기 ${size}B가 한도 ${maxInputBytes}B를 초과합니다`);
    if (fmt === "auto") fmt = detectFormat(data);
    if (!FORMATS.includes(fmt)) throw new ServiceError("BAD_FORMAT", `지원하지 않는 형식: ${fmt}`);
    if (fmt === "csv" || fmt === "tsv") {
      ({ columns, records } = parseDelimited(data, fmt === "tsv" ? "\t" : ","));
    } else if (fmt === "json") {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        throw new ServiceError("PARSE_ERROR", `JSON 파싱 실패: ${e.message}`);
      }
      if (!Array.isArray(parsed)) parsed = [parsed];
      return loadTable(parsed, "json", limits);
    } else {
      records = [];
      data.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line);
          if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("객체가 아님");
          records.push(obj);
        } catch (e) {
          throw new ServiceError("PARSE_ERROR", `JSONL ${i + 1}행 파싱 실패: ${e.message}`);
        }
      });
      columns = columnsFromRecords(records);
    }
  } else {
    throw new ServiceError("BAD_DATA", "data는 문자열 또는 객체 배열이어야 합니다");
  }
  if (records.length > maxRows) throw new ServiceError("TOO_MANY_ROWS", `행 수 ${records.length}가 한도 ${maxRows}를 초과합니다`);
  return { columns, records, format: fmt };
}

export function serialize(columns, records, format) {
  switch (format) {
    case "csv":
      return toDelimited(columns, records, ",");
    case "tsv":
      return toDelimited(columns, records, "\t");
    case "json":
      return JSON.stringify(records.map((r) => pick(r, columns)));
    case "jsonl":
      return records.map((r) => JSON.stringify(pick(r, columns))).join("\n") + (records.length ? "\n" : "");
    default:
      throw new ServiceError("BAD_FORMAT", `지원하지 않는 출력 형식: ${format}`);
  }
}

function pick(r, columns) {
  const o = {};
  for (const c of columns) if (r[c] !== undefined) o[c] = r[c];
  return o;
}

export function isBlank(v) {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

// ---- 값 판별/표준화 ----
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** 다양한 날짜 표기를 YYYY-MM-DD로 변환. 실패 시 null */
export function parseDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let y, m, d, m2;
  if ((m2 = s.match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})일?(?:[T\s].*)?$/))) [, y, m, d] = m2;
  else if ((m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = m2;
  else if ((m2 = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    // 모호한 경우 MM/DD/YYYY(미국식) 우선, 첫 값이 12 초과면 DD/MM/YYYY
    const a = +m2[1], b = +m2[2];
    if (a > 12) [d, m, y] = [a, b, m2[3]];
    else [m, d, y] = [a, b, m2[3]];
  } else if ((m2 = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/))) {
    [d, m, y] = [m2[1], MONTHS[m2[2].toLowerCase()], m2[3]];
  } else if ((m2 = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    [m, d, y] = [MONTHS[m2[1].toLowerCase()], m2[2], m2[3]];
  } else return null;
  y = +y; m = +m; d = +d;
  if (!m || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 2월 30일 등 존재하지 않는 날짜
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,234.50", "$12", "₩3,000", "(15)" 등 → number. 실패 시 null */
export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) (neg = true), (s = s.slice(1, -1));
  s = s.replace(/^[$€£¥₩]|(?:원|USD|KRW|USDC)$/gi, "").trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? (neg ? -n : n) / 100 : null;
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const TRUE_SET = new Set(["true", "t", "yes", "y", "1", "on", "예", "네", "o"]);
const FALSE_SET = new Set(["false", "f", "no", "n", "0", "off", "아니오", "아니요", "x"]);
export function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (TRUE_SET.has(s)) return true;
  if (FALSE_SET.has(s)) return false;
  return null;
}

/** 열 값들로 타입 추론 */
export function inferType(values) {
  const vals = values.filter((v) => !isBlank(v));
  if (vals.length === 0) return "empty";
  const all = (fn) => vals.every(fn);
  if (all((v) => typeof v === "boolean" || /^(true|false)$/i.test(String(v).trim()))) return "boolean";
  if (all((v) => { const n = parseNumber(v); return n !== null && Number.isInteger(n) && !/[.%]/.test(String(v)); })) return "integer";
  if (all((v) => parseNumber(v) !== null)) return "number";
  if (all((v) => /\d/.test(String(v)) && parseDate(v) !== null)) return "date";
  if (all((v) => EMAIL_RE.test(String(v).trim()))) return "email";
  if (all((v) => URL_RE.test(String(v).trim()))) return "url";
  if (all((v) => typeof v === "object")) return "object";
  return "string";
}
