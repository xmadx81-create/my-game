#!/usr/bin/env node
// 관리자 도구
//   node src/bin/admin.js approvals                          승인 내역
//   node src/bin/admin.js approve <action> --by <이름> [--hours N] [--note "..."]
//   node src/bin/admin.js revoke <action>
//   node src/bin/admin.js offerings                         등록 명령 미리보기(dry-run)
//   node src/bin/admin.js offerings --apply                 실제 등록 ('register-offerings' 승인 필요)
//   node src/bin/admin.js metrics                           관제 지표 JSON 출력
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ROOT } from "../config.js";
import { Store } from "../core/store.js";
import { Guard } from "../core/guard.js";
import { computeMetrics } from "../core/metrics.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const guard = new Guard(store, cfg.policy);
const [cmd, arg] = process.argv.slice(2);
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };

function offeringArgs(o) {
  return ["offering", "create", "--name", o.name, "--description", o.description, "--price-type", "fixed", "--price-value", o.priceUsdc.toFixed(2), "--sla-minutes", String(o.slaMinutes), "--requirements", JSON.stringify(o.requirements), "--deliverable", o.deliverable, "--no-required-funds", "--no-hidden", "--json"];
}

try {
  switch (cmd) {
    case "approvals":
      console.table(store.state.approvals);
      break;
    case "approve":
      console.log(guard.approve(arg, flag("--by"), { note: flag("--note") || "", hours: Number(flag("--hours")) || 0 }));
      break;
    case "revoke":
      console.log(`${guard.revoke(arg)}건 철회`);
      break;
    case "metrics":
      console.log(JSON.stringify(computeMetrics(store.state, cfg), null, 2));
      break;
    case "offerings": {
      const apply = process.argv.includes("--apply");
      const testnet = process.env.IS_TESTNET === "true";
      if (apply) {
        guard.require("register-offerings");
        if (!testnet) guard.require("mainnet");
      }
      const bin = process.env.ACP_BIN || (existsSync(join(ROOT, "node_modules/.bin/acp")) ? join(ROOT, "node_modules/.bin/acp") : "acp");
      for (const o of cfg.offerings) {
        const a = offeringArgs(o);
        if (!apply) {
          console.log(`[dry-run] ${testnet ? "IS_TESTNET=true " : ""}acp ${a.map((x) => (/[\s{"]/.test(x) ? `'${x}'` : x)).join(" ")}\n`);
          continue;
        }
        console.log(execFileSync(bin, a, { encoding: "utf8", env: process.env }));
      }
      if (!apply) console.log("※ 실제 등록: 관리자 승인(register-offerings) 후 --apply. 메인넷은 'mainnet' 승인 추가 필요");
      break;
    }
    default:
      console.log("사용법: approvals | approve <action> --by <이름> | revoke <action> | offerings [--apply] | metrics");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
