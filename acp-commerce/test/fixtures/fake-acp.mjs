#!/usr/bin/env node
// 테스트용 가짜 acp 바이너리: 호출 인자를 기록하고 공식 CLI와 같은 JSON 형태로 응답
import { appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(args) + "\n");
const [a, b] = args;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (a === "wallet" && b === "address") out({ address: "0xFAKEPROVIDER" });
else if (a === "wallet" && b === "balance") out({ chainId: 84532, address: "0xFAKEPROVIDER", tokens: [
  { tokenAddress: null, tokenBalance: "0x2386f26fc10000", tokenMetadata: { symbol: null, decimals: null } },
  { tokenAddress: "0xecc22a8f6fd62388498fba19813e214605a2bdb3", tokenBalance: "0xbebc20", tokenMetadata: { symbol: "USDC", decimals: 6 } },
] });
else if (a === "events" && b === "listen") setTimeout(() => {}, 1e9);
else if (a === "events" && b === "drain") {
  const f = args[args.indexOf("--file") + 1];
  const lines = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  writeFileSync(f, "");
  out({ events: lines.map((l) => JSON.parse(l)), remaining: 0 });
} else if (a === "job" && b === "list") out({ jobs: [{ jobId: "77", description: "Data Validation", status: "open" }] });
else if (a === "provider" && b === "set-budget") out({ success: true, action: "set-budget", jobId: args[args.indexOf("--job-id") + 1] });
else if (a === "provider" && b === "submit") out({ success: true, action: "submit" });
else if (a === "message" && b === "send") out({ success: true });
else { process.stderr.write(JSON.stringify({ error: "unknown", code: "X" }) + "\n"); process.exit(1); }
