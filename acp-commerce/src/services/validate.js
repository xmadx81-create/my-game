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
    default: throw new ServiceError("BAD_SCHEMA", `지원하지 않는 타입: ${type}`);
  }
}

function safeRegex(pattern) {
  if (typeof pattern !== "string" || pattern.length > 200) throw new ServiceError("BAD_SCHEMA", "pattern은 200자 이하 문자열이어야 합니다");
  // ReDoS 방지: 중첩 수량자 차단
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new ServiceError("BAD_SCHEMA", "중첩 반복 패턴은 허용되지 않습니다");
  try { return new RegExp(pattern); } catch (e) { throw new ServiceError("BAD_SCHEMA", `잘못된 정규식: ${e.message}`); }
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
  const add = (row, column, rule, value, message) => {
    errorCount++;
    byRule[rule] = (byRule[rule] || 0) + 1;
    if (errors.length < maxErrors) errors.push({ row, column, rule, value: value === undefined ? null : value, message });
  };

  const profile = profileColumns(columns, records);
  let checkedRules = 0;

  if (schema) {
    const colDefs = schema.columns || {};
    if (typeof colDefs !== "object" || Array.isArray(colDefs)) throw new ServiceError("BAD_SCHEMA", "schema.columns는 객체여야 합니다");
    for (const [col, def] of Object.entries(colDefs)) {
      if (def.type && !TYPES.includes(def.type)) throw new ServiceError("BAD_SCHEMA", `${col}: 지원하지 않는 타입 ${def.type}`);
      if (!columns.includes(col)) {
        if (def.required) add(null, col, "missing_column", null, `필수 열 "${col}"이 없습니다`);
        continue;
      }
      const re = def.pattern ? safeRegex(def.pattern) : null;
      const seen = new Map();
      records.forEach((r, idx) => {
        const rowNo = idx + 1;
        const v = r[col];
        checkedRules++;
        if (isBlank(v)) {
          if (def.required) add(rowNo, col, "required", v, "필수 값이 비어 있습니다");
          return;
        }
        if (def.type && !checkType(v, def.type)) { add(rowNo, col, "type", v, `${def.type} 형식이 아닙니다`); return; }
        const n = def.type === "number" || def.type === "integer" ? parseNumber(v) : null;
        if (def.min !== undefined && n !== null && n < def.min) add(rowNo, col, "min", v, `최솟값 ${def.min} 미만`);
        if (def.max !== undefined && n !== null && n > def.max) add(rowNo, col, "max", v, `최댓값 ${def.max} 초과`);
        if (def.type === "date") {
          const d = parseDate(v);
          if (def.min && d < parseDate(def.min)) add(rowNo, col, "min", v, `${def.min} 이전 날짜`);
          if (def.max && d > parseDate(def.max)) add(rowNo, col, "max", v, `${def.max} 이후 날짜`);
        }
        const s = String(v);
        if (def.minLength !== undefined && s.length < def.minLength) add(rowNo, col, "minLength", v, `길이 ${def.minLength} 미만`);
        if (def.maxLength !== undefined && s.length > def.maxLength) add(rowNo, col, "maxLength", v, `길이 ${def.maxLength} 초과`);
        if (re && !re.test(s)) add(rowNo, col, "pattern", v, `패턴 불일치: ${def.pattern}`);
        if (Array.isArray(def.enum) && !def.enum.map(String).includes(s)) add(rowNo, col, "enum", v, `허용값 아님: ${def.enum.join(", ")}`);
        if (def.unique) {
          const key = s.toLowerCase();
          if (seen.has(key)) add(rowNo, col, "unique", v, `${seen.get(key)}행과 중복`);
          else seen.set(key, rowNo);
        }
      });
    }
    if (schema.allowExtraColumns === false) {
      for (const c of columns) if (!(c in colDefs)) add(null, c, "extra_column", null, `스키마에 없는 열 "${c}"`);
    }
    if (Array.isArray(schema.uniqueTogether) && schema.uniqueTogether.length) {
      const keys = schema.uniqueTogether;
      const seen = new Map();
      records.forEach((r, idx) => {
        const k = JSON.stringify(keys.map((c) => String(r[c] ?? "").toLowerCase()));
        if (seen.has(k)) add(idx + 1, keys.join("+"), "unique_together", null, `${seen.get(k)}행과 복합키 중복`);
        else seen.set(k, idx + 1);
      });
    }
  } else {
    // 스키마 미제공: 자동 검수 (전체 중복행, 완전 빈 행, 추론 타입 불일치)
    const seen = new Map();
    records.forEach((r, idx) => {
      const rowNo = idx + 1;
      const values = columns.map((c) => r[c]);
      if (values.every(isBlank)) add(rowNo, null, "empty_row", null, "빈 행");
      const key = JSON.stringify(values);
      if (seen.has(key)) add(rowNo, null, "duplicate_row", null, `${seen.get(key)}행과 완전 중복`);
      else seen.set(key, rowNo);
    });
    for (const c of columns) {
      const nonBlank = records.map((r, i) => [r[c], i + 1]).filter(([v]) => !isBlank(v));
      // 다수(>=90%)가 숫자/날짜/이메일인 열에서 예외값 탐지
      for (const t of ["number", "date", "email"]) {
        const ok = nonBlank.filter(([v]) => checkType(v, t));
        if (nonBlank.length >= 5 && ok.length / nonBlank.length >= 0.9 && ok.length < nonBlank.length) {
          for (const [v, rowNo] of nonBlank) if (!checkType(v, t)) add(rowNo, c, "type_outlier", v, `열 대부분이 ${t}인데 형식이 다릅니다`);
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

  return {
    summary: {
      valid: errorCount === 0,
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
