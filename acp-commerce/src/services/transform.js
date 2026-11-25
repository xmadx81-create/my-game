// 상품 2: 데이터 변환 (Data Transformation)
// 형식 변환(CSV/TSV/JSON/JSONL) + 연산 파이프라인(rename/select/drop/cast/flatten/filter/sort/concat/split/fill/limit)
import { loadTable, serialize, isBlank, parseDate, parseNumber, parseBoolean, ServiceError, FORMATS } from "./common.js";

export const OPERATIONS = ["rename", "select", "drop", "cast", "flatten", "filter", "sort", "concat", "split", "fill", "limit"];
const MAX_OPS = 50;

function flattenObject(obj, sep, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}${sep}${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) flattenObject(v, sep, key, out);
    else if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== "object") ? v.join("|") : JSON.stringify(v);
    else out[key] = v;
  }
  return out;
}

function castValue(v, type) {
  if (isBlank(v)) return { ok: true, value: null };
  switch (type) {
    case "string":
      return { ok: true, value: typeof v === "object" ? JSON.stringify(v) : String(v) };
    case "number": {
      const n = parseNumber(v);
      return n === null ? { ok: false } : { ok: true, value: n };
    }
    case "integer": {
      const n = parseNumber(v);
      return n === null || !Number.isInteger(n) ? { ok: false } : { ok: true, value: n };
    }
    case "boolean": {
      const b = parseBoolean(v);
      return b === null ? { ok: false } : { ok: true, value: b };
    }
    case "date": {
      const d = parseDate(v);
      return d === null ? { ok: false } : { ok: true, value: d };
    }
    default:
      throw new ServiceError("BAD_OPERATION", `Unsupported cast type: ${type}`);
  }
}

function compare(a, b) {
  if (a === b) return 0;
  if (isBlank(a)) return 1; // 빈 값은 항상 뒤로
  if (isBlank(b)) return -1;
  const na = typeof a === "number" ? a : parseNumber(a);
  const nb = typeof b === "number" ? b : parseNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b));
}

function matches(v, operator, target) {
  switch (operator) {
    case "eq": return String(v ?? "") === String(target);
    case "ne": return String(v ?? "") !== String(target);
    case "gt": return !isBlank(v) && compare(v, target) > 0;
    case "gte": return !isBlank(v) && compare(v, target) >= 0;
    case "lt": return !isBlank(v) && compare(v, target) < 0;
    case "lte": return !isBlank(v) && compare(v, target) <= 0;
    case "contains": return String(v ?? "").toLowerCase().includes(String(target).toLowerCase());
    case "in": return Array.isArray(target) && target.map(String).includes(String(v ?? ""));
    case "empty": return isBlank(v);
    case "notEmpty": return !isBlank(v);
    default: throw new ServiceError("BAD_OPERATION", `Unsupported filter operator: ${operator}`);
  }
}

function requireColumns(columns, list, op) {
  const missing = list.filter((c) => !columns.includes(c));
  if (missing.length) throw new ServiceError("BAD_OPERATION", `${op}: unknown column(s) ${missing.join(", ")}`);
}

export function runTransform(req, limits) {
  const table = loadTable(req.data, req.format, limits);
  const outputFormat = req.outputFormat || (table.format === "json" ? "csv" : "json");
  if (!FORMATS.includes(outputFormat)) throw new ServiceError("BAD_FORMAT", `Unsupported outputFormat: ${outputFormat}`);
  const ops = req.operations ?? [];
  if (!Array.isArray(ops)) throw new ServiceError("BAD_OPERATION", "operations must be an array");
  if (ops.length > MAX_OPS) throw new ServiceError("BAD_OPERATION", `At most ${MAX_OPS} operations are allowed`);

  let { columns, records } = table;
  records = records.map((r) => ({ ...r }));
  const log = [];

  // JSON 중첩 구조는 CSV/TSV로 내보낼 때 자동 평탄화
  const hasNested = records.some((r) => Object.values(r).some((v) => v !== null && typeof v === "object"));
  const autoFlatten = hasNested && (outputFormat === "csv" || outputFormat === "tsv") && !ops.some((o) => o.op === "flatten");
  const pipeline = autoFlatten ? [{ op: "flatten", separator: ".", auto: true }, ...ops] : ops;

  for (const [i, o] of pipeline.entries()) {
    if (!o || !OPERATIONS.includes(o.op)) throw new ServiceError("BAD_OPERATION", `Invalid operation #${i + 1}: ${o?.op}`);
    const before = records.length;
    switch (o.op) {
      case "rename": {
        const map = o.map || {};
        requireColumns(columns, Object.keys(map), "rename");
        columns = columns.map((c) => map[c] ?? c);
        records = records.map((r) => { const n = {}; for (const [k, v] of Object.entries(r)) n[map[k] ?? k] = v; return n; });
        break;
      }
      case "select":
        requireColumns(columns, o.columns || [], "select");
        columns = [...o.columns];
        break;
      case "drop":
        requireColumns(columns, o.columns || [], "drop");
        columns = columns.filter((c) => !o.columns.includes(c));
        break;
      case "cast": {
        const types = o.types || {};
        requireColumns(columns, Object.keys(types), "cast");
        let failed = 0;
        const onError = o.onError || "null"; // null | keep | fail
        for (const r of records)
          for (const [col, t] of Object.entries(types)) {
            const res = castValue(r[col], t);
            if (res.ok) r[col] = res.value;
            else {
              failed++;
              if (onError === "fail") throw new ServiceError("CAST_FAILED", `Cannot cast value "${r[col]}" in column ${col} to ${t}`);
              if (onError === "null") r[col] = null;
            }
          }
        log.push({ op: "cast", failedCells: failed });
        continue;
      }
      case "flatten": {
        const sep = o.separator ?? ".";
        records = records.map((r) => flattenObject(r, sep));
        const seen = new Set(), cols = [];
        for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
        columns = cols;
        break;
      }
      case "filter":
        requireColumns(columns, [o.column], "filter");
        records = records.filter((r) => matches(r[o.column], o.operator || "eq", o.value));
        break;
      case "sort": {
        const by = Array.isArray(o.by) ? o.by : [o.by];
        requireColumns(columns, by, "sort");
        const dir = o.order === "desc" ? -1 : 1;
        records = records.map((r, idx) => [r, idx]).sort(([a, ia], [b, ib]) => {
          for (const c of by) { const x = compare(a[c], b[c]); if (x) return isBlank(a[c]) || isBlank(b[c]) ? x : x * dir; }
          return ia - ib; // 안정 정렬
        }).map(([r]) => r);
        break;
      }
      case "concat": {
        requireColumns(columns, o.columns || [], "concat");
        if (!o.into) throw new ServiceError("BAD_OPERATION", "concat: \"into\" is required");
        for (const r of records) r[o.into] = o.columns.map((c) => r[c]).filter((v) => !isBlank(v)).join(o.separator ?? " ");
        if (!columns.includes(o.into)) columns.push(o.into);
        break;
      }
      case "split": {
        requireColumns(columns, [o.column], "split");
        if (!Array.isArray(o.into) || !o.into.length) throw new ServiceError("BAD_OPERATION", "split: \"into\" must be a non-empty array");
        const sep = o.separator ?? " ";
        for (const r of records) {
          const parts = isBlank(r[o.column]) ? [] : String(r[o.column]).split(sep);
          o.into.forEach((c, idx) => { r[c] = idx === o.into.length - 1 ? parts.slice(idx).join(sep) || null : parts[idx] ?? null; });
        }
        for (const c of o.into) if (!columns.includes(c)) columns.push(c);
        break;
      }
      case "fill": {
        requireColumns(columns, [o.column], "fill");
        let filled = 0;
        let last = null;
        for (const r of records) {
          if (isBlank(r[o.column])) {
            if (o.strategy === "forward") { if (last !== null) (r[o.column] = last), filled++; }
            else (r[o.column] = o.value ?? null), filled++;
          } else last = r[o.column];
        }
        log.push({ op: "fill", filledCells: filled });
        continue;
      }
      case "limit":
        records = records.slice(o.offset ?? 0, (o.offset ?? 0) + (o.n ?? records.length));
        break;
    }
    log.push({ op: o.op, ...(o.auto ? { auto: true } : {}), rowsBefore: before, rowsAfter: records.length });
  }

  const output = serialize(columns, records, outputFormat);
  return {
    summary: { rowsIn: table.records.length, rowsOut: records.length, inputFormat: table.format, outputFormat, operationsApplied: log.length },
    operationsLog: log,
    columns,
    output: { format: outputFormat, rows: records.length, data: output },
  };
}
