import { test } from "node:test";
import assert from "node:assert/strict";
import { runClean } from "../src/services/clean.js";
import { runTransform } from "../src/services/transform.js";
import { runValidate } from "../src/services/validate.js";
import { parseDelimited, parseDate, parseNumber, loadTable } from "../src/services/common.js";
import { fulfil, resolveService } from "../src/services/index.js";
import { SAMPLE_CSV, SAMPLE_JSON, verifyDeliverable } from "../src/sim/scenarios.js";

const L = { maxInputBytes: 1_000_000, maxRows: 20_000, maxDeliverableBytes: 500_000 };

test("CSV 파서: 따옴표·이스케이프·개행 포함 셀", () => {
  const { columns, records } = parseDelimited('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\n');
  assert.deepEqual(columns, ["a", "b"]);
  assert.equal(records[0].a, "x, y");
  assert.equal(records[0].b, 'he said "hi"');
  assert.equal(records[1].a, "multi\nline");
});

test("날짜·숫자 파싱", () => {
  assert.equal(parseDate("2024/3/5"), "2024-03-05");
  assert.equal(parseDate("05 Mar 2024"), "2024-03-05");
  assert.equal(parseDate("2024년 3월 5일"), "2024-03-05");
  assert.equal(parseDate("2024-02-30"), null);
  assert.equal(parseDate("2024-13-01"), null);
  assert.equal(parseNumber("1,200"), 1200);
  assert.equal(parseNumber("$35.50"), 35.5);
  assert.equal(parseNumber("(15)"), -15);
  assert.equal(parseNumber("12%"), 0.12);
  assert.equal(parseNumber("abc"), null);
});

test("정제: 중복·빈행 제거, 표준화", () => {
  const r = runClean({ data: SAMPLE_CSV }, L);
  assert.equal(r.summary.rowsIn, 6);
  assert.equal(r.summary.duplicatesDropped, 1);
  assert.equal(r.summary.emptyRowsDropped, 1);
  assert.equal(r.summary.rowsOut, 4);
  assert.ok(r.columns.includes("e_mail"));
  assert.match(r.output.data, /kim@example\.com,010-1234-5678,2024-03-05,1200,true/);
  assert.match(r.output.data, /010-2222-3333,2024-13-01/); // 잘못된 날짜는 원본 유지
  assert.match(r.output.data, /Lee Jiwon,lee@example.com,010-9876-5432,2024-03-05,35.5,false/);
  assert.equal(r.summary.invalidDates, 1);
});

test("정제: dedupeKeys 지정 열 없음 → 오류", () => {
  assert.throws(() => runClean({ data: SAMPLE_CSV, options: { dedupeKeys: ["nope"] } }, L), /dedupeKeys/);
});

test("변환: 중첩 JSON → CSV 자동 평탄화 + 필터·정렬·형변환", () => {
  const r = runTransform({ data: SAMPLE_JSON, outputFormat: "csv", operations: [{ op: "cast", types: { amount: "number" } }, { op: "filter", column: "user.country", operator: "eq", value: "KR" }, { op: "sort", by: "id" }] }, L);
  const lines = r.output.data.trim().split("\n");
  assert.equal(lines[0], "id,user.name,user.country,tags,amount,date");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2,Cid,KR,new,,/); // abc → null
  assert.match(lines[2], /^3,Ann,KR,vip\|new,12.5,/);
});

test("변환: 존재하지 않는 열/연산 거부", () => {
  assert.throws(() => runTransform({ data: SAMPLE_CSV, outputFormat: "json", operations: [{ op: "drop", columns: ["x"] }] }, L), /존재하지 않는 열/);
  assert.throws(() => runTransform({ data: SAMPLE_CSV, outputFormat: "json", operations: [{ op: "eval" }] }, L), /올바르지 않습니다/);
});

test("변환: split·concat·limit, JSONL 왕복", () => {
  const r = runTransform({ data: "full\nKim Minsu\nLee Ji Won\n", outputFormat: "jsonl", operations: [{ op: "split", column: "full", into: ["last", "first"] }, { op: "concat", columns: ["first", "last"], into: "name", separator: " " }, { op: "limit", n: 1 }] }, L);
  assert.deepEqual(JSON.parse(r.output.data.trim()), { full: "Kim Minsu", last: "Kim", first: "Minsu", name: "Minsu Kim" });
  const back = loadTable(runTransform({ data: "a,b\n1,2\n", outputFormat: "jsonl" }, L).output.data, "jsonl");
  assert.deepEqual(back.records, [{ a: "1", b: "2" }]);
});

test("검수: 스키마 규칙별 오류 집계", () => {
  const r = runValidate({ data: SAMPLE_CSV, schema: { columns: { "E-Mail": { type: "email", required: true, unique: true }, "Order Amount": { type: "number", min: 0 }, "Signup Date": { type: "date" }, Missing: { required: true } } } }, L);
  assert.equal(r.summary.valid, false);
  assert.equal(r.errorsByRule.unique, 1);
  assert.equal(r.errorsByRule.missing_column, 1);
  assert.ok(r.errorsByRule.type >= 3); // park@example, "-", 2024-13-01
  assert.equal(Object.values(r.errorsByRule).reduce((a, b) => a + b, 0), r.summary.errorCount);
});

test("검수: ReDoS 위험 패턴 차단", () => {
  assert.throws(() => runValidate({ data: "a\nx\n", schema: { columns: { a: { pattern: "(a+)+$" } } } }, L), /중첩 반복/);
});

test("검수: 스키마 없으면 자동 프로파일 (완전 중복행 탐지)", () => {
  const r = runValidate({ data: "a,b\n1,2\n1,2\n3,4\n" }, L);
  assert.equal(r.summary.mode, "auto-profile");
  assert.equal(r.errorsByRule.duplicate_row, 1);
  assert.equal(r.profile.a.inferredType, "integer");
});

test("입력 한도 초과 거부", () => {
  assert.throws(() => loadTable("a\n" + "x\n".repeat(30), "csv", { maxRows: 10 }), /한도/);
  assert.throws(() => loadTable("x".repeat(2000), "csv", { maxInputBytes: 1000 }), /한도/);
});

test("납품물: sha256 무결성 + QA 통과, 구매자 검수기 통과", () => {
  for (const [svc, req] of [["data-clean", { data: SAMPLE_CSV }], ["data-transform", { data: SAMPLE_JSON, outputFormat: "tsv" }], ["data-validate", { data: SAMPLE_CSV }]]) {
    const r = fulfil("j1", svc, req, L);
    assert.equal(r.ok, true, svc);
    assert.equal(verifyDeliverable(r.deliverable.text).ok, true, svc);
    const tampered = r.deliverable.text.replace('"jobId":"j1"', '"jobId":"j2"');
    assert.equal(verifyDeliverable(tampered).ok, false);
  }
});

test("납품물 크기 한도 초과 시 QA 실패", () => {
  const r = fulfil("j", "data-clean", { data: SAMPLE_CSV }, { ...L, maxDeliverableBytes: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "QA_FAILED");
});

test("서비스 라우팅", () => {
  const offerings = [{ name: "Data Validation", service: "data-validate" }];
  assert.equal(resolveService({ data: "x", service: "data-transform" }, null, offerings), "data-transform");
  assert.equal(resolveService({ data: "x" }, "Data Validation", offerings), "data-validate");
  assert.equal(resolveService({ data: "x", schema: {} }, null, []), "data-validate");
  assert.equal(resolveService({ data: "x", operations: [] }, null, []), "data-transform");
  assert.equal(resolveService({ data: "x" }, null, []), "data-clean");
  assert.equal(resolveService({ prompt: "logo" }, "Logo", offerings), null);
});
