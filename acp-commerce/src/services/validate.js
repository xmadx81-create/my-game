// 상품 3: 데이터 검수 (Data Validation / QA Report)
// 스키마 기반 규칙 검사 + 스키마 미제공 시 자동 프로파일링, 품질점수(0~100) 산출
import { loadTable, isBlank, parseDate, parseNumber, parseBoolean, inferType, EMAIL_RE, URL_RE, ServiceError } from "./common.js";

const TYPES = ["string", "number", "integer", "boolean", "date", "email", "url"];

function checkType(v, type) {
  switch (type) {
    case "string": return true;
    case "number": return parseNumber(v) !== null;
    case "integer": { const n = parseNumber(v); return n !== null && Number.isInteger(n); }
    case "boolean": return parseBoolean(v) !== null;
    case "date": return parseDate(v) !== null;
    case "email": return EMAIL_RE.test(String(v).trim());
    case "url": return URL_RE.test(String(v).trim());
    default: throw new ServiceError("BAD_SCHEMA", `Unsupported type: ${type}`);
  }
}

function safeRegex(pattern) {
  if (typeof pattern !== "string" || pattern.length > 200) throw new ServiceError("BAD_SCHEMA", "pattern must be a string of at most 200 characters");
  // ReDoS 방지: 중첩 수량자 차단
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new ServiceError("BAD_SCHEMA", "Nested quantifiers are not allowed (ReDoS protection)");
  try { return new RegExp(pattern); } catch (e) { throw new ServiceError("BAD_SCHEMA", `Invalid regex: ${e.message}`); }
}

/** 오류값에 대한 수정 제안 (확실한 경우에만; 추측성 보정 금지) */
export function suggestFix(rule, value, def = {}) {
  if (value === null || value === undefined) return null;
  const v = String(value);
  const t = v.trim();
  if (rule === "type") {
    if (def.type === "email") { const e = t.toLowerCase().replace(/\s+/g, ""); return EMAIL_RE.test(e) && e !== v ? e : null; }
    if (def.type === "date") return null; // 날짜는 임의 보정하지 않음 (존재하지 않는 날짜 등)
    if (def.type === "number" || def.type === "integer") { const n = parseNumber(t.replace(/\s+/g, "")); return n !== null && (def.type === "number" || Number.isInteger(n)) ? n : null; }
    if (def.type === "boolean") { const b = parseBoolean(t); return b; }
    if (def.type === "url" && /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t)) return "https://" + t;
  }
  if (rule === "enum" && Array.isArray(def.enum)) {
    const hit = def.enum.find((e) => String(e).toLowerCase() === t.toLowerCase());
    return hit !== undefined ? hit : null;
  }
  if ((rule === "minLength" || rule === "maxLength" || rule === "pattern") && t !== v) {
    // 앞뒤 공백 때문에 실패한 경우만 제안
    return t;
  }
  return null;
}

export function profileColumns(columns, records) {
  const profile = {};
  for (const c of columns) {
    const values = records.map((r) => r[c]);
    const nonBlank = values.filter((v) => !isBlank(v));
    const distinct = new Set(nonBlank.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))));
    const type = inferType(values);
    const p = {
      inferredType: type,
      nullCount: values.length - nonBlank.length,
      nullRate: values.length ? +((values.length - nonBlank.length) / values.length).toFixed(4) : 0,
      distinctCount: distinct.size,
    };
    if (type === "number" || type === "integer") {
      const nums = nonBlank.map(parseNumber).filter((n) => n !== null);
      if (nums.length) Object.assign(p, { min: Math.min(...nums), max: Math.max(...nums), mean: +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(6) });
    }
    if (type === "string") {
      const lens = nonBlank.map((v) => String(v).length);
      if (lens.length) Object.assign(p, { minLength: Math.min(...lens), maxLength: Math.max(...lens) });
    }
    profile[c] = p;
  }
  return profile;
}

export function runValidate(req, limits) {
  const table = loadTable(req.data, req.format, limits);
  const { columns, records } = table;
  const maxErrors = Math.min(Math.max(+req.maxErrors || 100, 1), 1000);
  const schema = req.schema || null;
  const errors = [];
  const byRule = {};
  let errorCount = 0;
  const errorRows = new Set();
  const byColumn = {};
  let suggestedCount = 0;
  const add = (row, column, rule, value, message, def) => {
    errorCount++;
    byRule[rule] = (byRule[rule] || 0) + 1;
    if (row !== null) errorRows.add(row);
    if (column) byColumn[column] = (byColumn[column] || 0) + 1;
    const suggestion = def ? suggestFix(rule, value, def) : null;
    if (suggestion !== null && suggestion !== undefined) suggestedCount++;
    if (errors.length < maxErrors) errors.push({ row, column, rule, value: value === undefined ? null : value, message, ...(suggestion !== null && suggestion !== undefined ? { suggestion } : {}) });
  };

  const profile = profileColumns(columns, records);
  let checkedRules = 0;

  if (schema) {
    const colDefs = schema.columns || {};
    if (typeof colDefs !== "object" || Array.isArray(colDefs)) throw new ServiceError("BAD_SCHEMA", "schema.columns must be an object");
    for (const [col, def] of Object.entries(colDefs)) {
      if (def.type && !TYPES.includes(def.type)) throw new ServiceError("BAD_SCHEMA", `${col}: unsupported type ${def.type}`);
      if (!columns.includes(col)) {
        if (def.required) add(null, col, "missing_column", null, `Required column "${col}" is missing`);
        continue;
      }
      const re = def.pattern ? safeRegex(def.pattern) : null;
      const seen = new Map();
      records.forEach((r, idx) => {
        const rowNo = idx + 1;
        const v = r[col];
        checkedRules++;
        if (isBlank(v)) {
          if (def.required) add(rowNo, col, "required", v, "Required value is empty", def);
          return;
        }
        if (def.type && !checkType(v, def.type)) { add(rowNo, col, "type", v, `Not a valid ${def.type}`, def); return; }
        const n = def.type === "number" || def.type === "integer" ? parseNumber(v) : null;
        if (def.min !== undefined && n !== null && n < def.min) add(rowNo, col, "min", v, `Below minimum ${def.min}`, def);
        if (def.max !== undefined && n !== null && n > def.max) add(rowNo, col, "max", v, `Above maximum ${def.max}`, def);
        if (def.type === "date") {
          const d = parseDate(v);
          if (def.min && d < parseDate(def.min)) add(rowNo, col, "min", v, `Date before ${def.min}`, def);
          if (def.max && d > parseDate(def.max)) add(rowNo, col, "max", v, `Date after ${def.max}`, def);
        }
        const s = String(v);
        if (def.minLength !== undefined && s.length < def.minLength) add(rowNo, col, "minLength", v, `Shorter than ${def.minLength}`, def);
        if (def.maxLength !== undefined && s.length > def.maxLength) add(rowNo, col, "maxLength", v, `Longer than ${def.maxLength}`, def);
        if (re && !re.test(s)) add(rowNo, col, "pattern", v, `Does not match pattern ${def.pattern}`, def);
        if (Array.isArray(def.enum) && !def.enum.map(String).includes(s)) add(rowNo, col, "enum", v, `Not one of: ${def.enum.join(", ")}`, def);
        if (def.unique) {
          const key = s.toLowerCase();
          if (seen.has(key)) add(rowNo, col, "unique", v, `Duplicate of row ${seen.get(key)}`, def);
          else seen.set(key, rowNo);
        }
      });
    }
    if (schema.allowExtraColumns === false) {
      for (const c of columns) if (!(c in colDefs)) add(null, c, "extra_column", null, `Column "${c}" is not in the schema`);
    }
    if (Array.isArray(schema.uniqueTogether) && schema.uniqueTogether.length) {
      const keys = schema.uniqueTogether;
      const seen = new Map();
      records.forEach((r, idx) => {
        const k = JSON.stringify(keys.map((c) => String(r[c] ?? "").toLowerCase()));
        if (seen.has(k)) add(idx + 1, keys.join("+"), "unique_together", null, `Composite key duplicates row ${seen.get(k)}`);
        else seen.set(k, idx + 1);
      });
    }
  } else {
    // 스키마 미제공: 자동 검수 (전체 중복행, 완전 빈 행, 추론 타입 불일치)
    const seen = new Map();
    records.forEach((r, idx) => {
      const rowNo = idx + 1;
      const values = columns.map((c) => r[c]);
      if (values.every(isBlank)) add(rowNo, null, "empty_row", null, "Empty row");
      const key = JSON.stringify(values);
      if (seen.has(key)) add(rowNo, null, "duplicate_row", null, `Exact duplicate of row ${seen.get(key)}`);
      else seen.set(key, rowNo);
    });
    for (const c of columns) {
      const nonBlank = records.map((r, i) => [r[c], i + 1]).filter(([v]) => !isBlank(v));
      // 다수(>=90%)가 숫자/날짜/이메일인 열에서 예외값 탐지
      for (const t of ["number", "date", "email"]) {
        const ok = nonBlank.filter(([v]) => checkType(v, t));
        if (nonBlank.length >= 5 && ok.length / nonBlank.length >= 0.9 && ok.length < nonBlank.length) {
          for (const [v, rowNo] of nonBlank) if (!checkType(v, t)) add(rowNo, c, "type_outlier", v, `Most values in this column are ${t}, but this one is not`);
          break;
        }
      }
      checkedRules += nonBlank.length;
    }
  }

  const cells = Math.max(records.length * Math.max(columns.length, 1), 1);
  const totalNulls = Object.values(profile).reduce((a, p) => a + p.nullCount, 0);
  const completeness = 1 - totalNulls / cells;
  const errorRate = Math.min(errorCount / cells, 1);
  const qualityScore = Math.round(Math.max(0, Math.min(100, completeness * 40 + (1 - errorRate) * 60)));

  // 개선 권고 (구매자가 바로 조치할 수 있는 수준으로)
  const recommendations = [];
  for (const [c, p] of Object.entries(profile)) {
    if (p.nullRate >= 0.2) recommendations.push(`Column "${c}" is ${(p.nullRate * 100).toFixed(0)}% empty; consider making it optional or backfilling it.`);
    if (p.inferredType === "string" && p.distinctCount === records.length && records.length >= 5 && /id|key|code/i.test(c)) recommendations.push(`Column "${c}" looks like a unique identifier; consider adding "unique": true to the schema.`);
  }
  for (const [c, n] of Object.entries(byColumn).sort((a, b) => b[1] - a[1]).slice(0, 3)) recommendations.push(`Column "${c}" has ${n} error(s); fix it first for the largest quality gain.`);
  if (suggestedCount) recommendations.push(`${suggestedCount} error(s) include a safe "suggestion" you can apply automatically.`);
  if (!schema) recommendations.push("No schema was provided; pass \"schema\" with column rules (type, required, unique, min/max, pattern, enum) for a stricter audit.");

  const notes = [
    errorCount === 0 ? `All ${records.length} rows passed validation.` : `${errorCount} issue(s) found in ${errorRows.size} of ${records.length} rows.`,
    `Quality score: QUALITY/100 (completeness ${(completeness * 100).toFixed(1)}%).`,
  ];

  return {
    notes: notes.map((n) => n.replace("QUALITY", String(qualityScore))),
    recommendations,
    errorsByColumn: byColumn,
    summary: {
      valid: errorCount === 0,
      rowsWithErrors: errorRows.size,
      suggestionsAvailable: suggestedCount,
      qualityScore,
      rowsChecked: records.length,
      columnsChecked: columns.length,
      errorCount,
      errorsReturned: errors.length,
      truncated: errorCount > errors.length,
      completeness: +completeness.toFixed(4),
      mode: schema ? "schema" : "auto-profile",
      checkedRules,
    },
    errorsByRule: byRule,
    errors,
    profile,
  };
}
