// 모의 거래 시나리오: 정상 주문, 처리 불가 입력, 구매자 거절, 미입금 만료까지 포함
import { createHash } from "node:crypto";

export const SAMPLE_CSV = `Customer Name, E-Mail ,Phone,Signup Date,Order Amount,VIP
 Kim  Minsu ,KIM@Example.COM,01012345678,2024/03/05,"1,200",yes
Lee Jiwon,lee@example.com,+82 10-9876-5432,05 Mar 2024,$35.50,no
 Kim  Minsu ,KIM@Example.COM,01012345678,2024/03/05,"1,200",yes
,,,,,
Park Soyeon,park@example,02-123-4567,N/A,-,Y
Choi Daeho,choi@example.com,010.2222.3333,2024-13-01,99,N
`;

export const SAMPLE_JSON = [
  { id: 3, user: { name: "Ann", country: "KR" }, tags: ["vip", "new"], amount: "12.5", date: "2024/01/02" },
  { id: 1, user: { name: "Bob", country: "US" }, tags: [], amount: "7", date: "Jan 5, 2024" },
  { id: 2, user: { name: "Cid", country: "KR" }, tags: ["new"], amount: "abc", date: "" },
];

/** 구매자 검수기: 해시 무결성 + 자체 QA 통과 여부 확인 (실제 구매자 에이전트의 표준 검수 흉내) */
export function verifyDeliverable(text) {
  try {
    const d = JSON.parse(text);
    if (d.status === "failed") return { ok: false, reason: `provider failure: ${d.code}` };
    const { sha256, ...body } = d;
    const calc = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (calc !== sha256) return { ok: false, reason: "sha256 mismatch" };
    if (!d.qa?.passed) return { ok: false, reason: "qa failed" };
    return { ok: true, reason: "hash+qa verified" };
  } catch (e) {
    return { ok: false, reason: `unparseable deliverable: ${e.message}` };
  }
}

export const SCENARIOS = [
  { label: "정제-CSV", offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV } },
  { label: "정제-JSON출력+중복키", offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV, outputFormat: "json", options: { dedupeKeys: ["E-Mail"] } } },
  { label: "변환-JSON→CSV", offeringName: "Data Transform", requirement: { data: SAMPLE_JSON, outputFormat: "csv", operations: [{ op: "cast", types: { amount: "number", date: "date" } }, { op: "filter", column: "user.country", operator: "eq", value: "KR" }, { op: "sort", by: "id" }] } },
  { label: "변환-CSV→JSONL", offeringName: "Data Transform", requirement: { data: SAMPLE_CSV, outputFormat: "jsonl", operations: [{ op: "rename", map: { "Customer Name": "name" } }, { op: "select", columns: ["name", "Order Amount"] }, { op: "fill", column: "name", value: "(unknown)" }] } },
  { label: "검수-스키마", offeringName: "Data Validation", requirement: { data: SAMPLE_CSV, schema: { columns: { "E-Mail": { type: "email", required: true, unique: true }, "Order Amount": { type: "number", min: 0 }, "Signup Date": { type: "date" }, VIP: { enum: ["yes", "no", "Y", "N"] } } } } },
  { label: "검수-자동프로파일", offeringName: "Data Validation", requirement: { data: SAMPLE_JSON } },
  { label: "불량입력-깨진CSV", offeringName: "Data Cleaning", requirement: { data: 'a,b\n"1,2\n3,4' }, expect: "declined" },
  { label: "불량입력-없는열", offeringName: "Data Transform", requirement: { data: SAMPLE_CSV, outputFormat: "csv", operations: [{ op: "select", columns: ["nope"] }] }, expect: "declined" },
  { label: "미지원요청", offeringName: "Logo Design", requirement: { prompt: "make a logo" }, expect: "declined" },
  { label: "구매자거절", offeringName: "Data Validation", requirement: { data: SAMPLE_CSV }, evaluate: () => ({ ok: false, reason: "buyer wanted different format" }), expect: "rejected" },
  { label: "미입금만료", offeringName: "Data Cleaning", requirement: { data: SAMPLE_CSV }, autoFund: false, expect: "expired" },
];
