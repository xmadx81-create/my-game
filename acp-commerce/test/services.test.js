import { test } from "node:test";
import assert from "node:assert/strict";
import { runClean } from "../src/services/clean.js";
import { runTransform } from "../src/services/transform.js";
import { runValidate } from "../src/services/validate.js";
import { parseDelimited, parseDate, parseNumber, loadTable } from "../src/services/common.js";
import { fulfil, resolveService } from "../src/services/index.js";
import { SAMPLE_CSV, SAMPLE_JSON, verifyDeliverable } from "../src/sim/scenarios.js";
import { findComparable, proposePrice } from "../src/core/pricing.js";

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
  assert.throws(() => runTransform({ data: SAMPLE_CSV, outputFormat: "json", operations: [{ op: "drop", columns: ["x"] }] }, L), /unknown column/);
  assert.throws(() => runTransform({ data: SAMPLE_CSV, outputFormat: "json", operations: [{ op: "eval" }] }, L), /Invalid operation/);
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
  assert.throws(() => runValidate({ data: "a\nx\n", schema: { columns: { a: { pattern: "(a+)+$" } } } }, L), /Nested quantifiers/);
});

test("검수: 스키마 없으면 자동 프로파일 (완전 중복행 탐지)", () => {
  const r = runValidate({ data: "a,b\n1,2\n1,2\n3,4\n" }, L);
  assert.equal(r.summary.mode, "auto-profile");
  assert.equal(r.errorsByRule.duplicate_row, 1);
  assert.equal(r.profile.a.inferredType, "integer");
});

test("입력 한도 초과 거부", () => {
  assert.throws(() => loadTable("a\n" + "x\n".repeat(30), "csv", { maxRows: 10 }), /exceeds the limit/);
  assert.throws(() => loadTable("x".repeat(2000), "csv", { maxInputBytes: 1000 }), /exceeds the limit/);
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

test("품질 강화: 유니코드 정규화·변경 예시·문제값 목록·요약", () => {
  const r = runClean({ data: "Name,Email,Joined\nＫｉｍ\u200b Minsu,KIM@EXAMPLE.COM,2024/3/5\nLee,bad@x,2024-13-01\n" }, L);
  assert.match(r.output.data, /^name,email,joined\nKim Minsu,kim@example.com,2024-03-05\nLee,bad@x,2024-13-01\n$/);
  assert.ok(r.changeSamples.some((c) => c.rule === "unicode" && c.after === "Kim Minsu"));
  assert.deepEqual(r.issues.map((i) => i.problem).sort(), ["invalid email format", "invalid or ambiguous date (kept as-is)"]);
  assert.equal(r.notes.length, 3);
});

test("품질 강화: 검수 오류의 안전한 수정 제안·권고·영문 메시지", () => {
  const data = "id,email,status,amount\n1,A@B .COM,Active,1 000\n2,x@y.io,active,5\n3,,pending,-1\n";
  const r = runValidate({ data, schema: { columns: { email: { type: "email", required: true }, status: { enum: ["active", "pending"] }, amount: { type: "number", min: 0 } } } }, L);
  const byRule = Object.fromEntries(r.errors.map((e) => [e.rule + ":" + e.column, e]));
  assert.equal(byRule["type:email"].suggestion, "a@b.com");
  assert.equal(byRule["enum:status"].suggestion, "active");
  assert.equal(byRule["type:amount"].suggestion, 1000);
  assert.equal(byRule["min:amount"].suggestion, undefined); // 음수는 임의 보정하지 않음
  assert.equal(r.summary.rowsWithErrors, 2); // 1행·3행 (2행은 정상)
  assert.ok(r.recommendations.some((x) => /safe "suggestion"/.test(x)));
  assert.match(byRule["required:email"].message, /^Required value is empty$/);
});

test("경쟁 가격: 유사 상품 최저가보다 10% 낮게, 하한가 유지, 없으면 현행 유지", () => {
  const agents = [
    { name: "A", walletAddress: "0xA", offerings: [{ name: "CSV Data Cleaning", description: "clean csv", priceType: "fixed", priceValue: 0.4 }, { name: "Logo", description: "logo design", priceType: "fixed", priceValue: 0.1 }] },
    { name: "B", walletAddress: "0xB", offerings: [{ name: "Dataset cleanup", description: "data cleaning and dedup", priceType: "fixed", priceValue: 0.25 }] },
    { name: "Me", walletAddress: "0xME", offerings: [{ name: "Data Cleaning", description: "data cleaning", priceType: "fixed", priceValue: 0.3 }] },
    { name: "C", walletAddress: "0xC", offerings: [{ name: "Data cleaning", description: "hidden", priceType: "fixed", priceValue: 0.01, isHidden: true }] },
  ];
  const comp = findComparable(agents, "data-clean", { excludeWallets: ["0xme"] });
  assert.deepEqual(comp.map((c) => c.priceUsdc), [0.25, 0.4]); // 자기 상품·숨김·무관 상품 제외
  assert.deepEqual(proposePrice({ currentUsdc: 0.3, comparable: comp }), { priceUsdc: 0.22, changed: true, reason: "10% below lowest comparable offering (0.25 USDC)", lowestCompetitorUsdc: 0.25 });
  assert.equal(proposePrice({ currentUsdc: 0.3, comparable: [{ priceUsdc: 0.03 }], floorUsdc: 0.05 }).priceUsdc, 0.05);
  assert.deepEqual(proposePrice({ currentUsdc: 0.3, comparable: [] }).changed, false);
});
