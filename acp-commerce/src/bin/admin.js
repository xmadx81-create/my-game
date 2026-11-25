#!/usr/bin/env node
// 관리자 도구
//   node src/bin/admin.js approvals                          승인 내역
//   node src/bin/admin.js approve <action> --by <이름> [--hours N] [--note "..."]
//   node src/bin/admin.js revoke <action>
//   node src/bin/admin.js offerings                         등록 명령 미리보기(dry-run)
//   node src/bin/admin.js offerings --apply [--only data-validate]  실제 등록 ('register-offerings' 승인 필요)
//   node src/bin/admin.js metrics                           관제 지표 JSON 출력
//   node src/bin/admin.js export-state <file>               서버 이전용 운영 상태 내보내기 (승인·가격이력·출시상품·백로그)
//   node src/bin/admin.js import-state <file>               운영 상태 가져오기 (기존 값과 병합)
//   node src/bin/admin.js pricing [--apply]                 경쟁 가격 조사·제안 (적용은 'price-change' 승인 필요)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ROOT, applyRuntimeOverlay } from "../config.js";
import { Store } from "../core/store.js";
import { Guard } from "../core/guard.js";
import { computeMetrics } from "../core/metrics.js";
import { cliEnv } from "../adapters/cli.js";
import { findComparable, proposePrice } from "../core/pricing.js";
import { guardPrice } from "../growth/priceGuard.js";
import { readFileSync, writeFileSync } from "node:fs";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
applyRuntimeOverlay(cfg, store.state);
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
      const only = flag("--only");
      const targets = only ? cfg.offerings.filter((o) => o.service === only) : cfg.offerings;
      if (only && !targets.length) throw new Error(`--only: 알 수 없는 서비스 ${only} (data-clean | data-transform | data-validate)`);
      const acpJson = (args) => JSON.parse(execFileSync(bin, [...args, "--json"], { encoding: "utf8", env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
      let live = [];
      if (apply) { const r = acpJson(["offering", "list"]); live = Array.isArray(r) ? r : r.data || []; }
      for (const o of targets) {
        const existing = live.find((x) => x.name === o.name);
        if (!apply) {
          const a = offeringArgs(o);
          console.log(`[dry-run] ${testnet ? "IS_TESTNET=true " : ""}acp ${a.map((x) => (/[\s{"]/.test(x) ? `'${x}'` : x)).join(" ")}\n`);
          continue;
        }
        if (existing) {
          // 동기화: 설명·납품물·요구사항·SLA 갱신. 가격이 다르면 'price-change' 승인 필요
          const args = ["offering", "update", "--offering-id", existing.id, "--description", o.description, "--deliverable", o.deliverable, "--requirements", JSON.stringify(o.requirements), "--sla-minutes", String(o.slaMinutes)];
          if (Number(existing.priceValue) !== o.priceUsdc) { guard.require("price-change"); args.push("--price-value", o.priceUsdc.toFixed(2)); }
          acpJson(args);
          console.log(`[updated] ${o.name} (${existing.id})`);
        } else {
          const r = acpJson(offeringArgs(o).slice(0, -1));
          console.log(`[created] ${o.name} (${r.id}) ${o.priceUsdc} USDC`);
        }
      }
      if (!apply) console.log("※ 실제 등록: 관리자 승인(register-offerings) 후 --apply. 메인넷은 'mainnet' 승인 추가 필요");
      break;
    }
    case "pricing": {
      const apply = process.argv.includes("--apply");
      const bin = process.env.ACP_BIN || (existsSync(join(ROOT, "node_modules/.bin/acp")) ? join(ROOT, "node_modules/.bin/acp") : "acp");
      const acp = (args) => JSON.parse(execFileSync(bin, [...args, "--json"], { encoding: "utf8", env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
      const me = (() => { try { return acp(["wallet", "address"]).address; } catch { return null; } })();
      const pc = cfg.policy.pricing;
      const rows = [];
      for (const o of cfg.offerings) {
        const agents = [];
        for (const q of pc.searchQueries[o.service] || []) {
          try { agents.push(...(acp(["browse", q, "--top-k", "25"]).data || [])); } catch (e) { console.error(`[browse "${q}"] ${e.message.split("\n")[0]}`); }
        }
        const uniq = [...new Map(agents.map((a) => [a.walletAddress, a])).values()];
        const comparable = findComparable(uniq, o.service, { excludeWallets: me ? [me] : [] });
        const raw = proposePrice({ currentUsdc: o.priceUsdc, comparable, undercutRate: pc.undercutRate, floorUsdc: pc.floorUsdc });
        // 모든 가격 변경은 가격 안전장치 통과 (하한·변동폭·쿨다운·누적 인하 한도)
        o.basePriceUsdc ??= o.priceUsdc;
        const g = raw.changed ? guardPrice({ product: o, requested: raw.priceUsdc, history: store.state.priceHistory || [], policy: cfg.policy }) : { priceUsdc: o.priceUsdc, changed: false };
        const p = { ...raw, priceUsdc: g.priceUsdc, changed: g.changed, reason: g.blocked ? `${raw.reason} | blocked: ${g.blocked}` : g.applied?.length ? `${raw.reason} | guard: ${g.applied.join(", ")}` : raw.reason };
        rows.push({ service: o.service, current: o.priceUsdc, proposed: p.priceUsdc, competitors: comparable.length, lowest: p.lowestCompetitorUsdc ?? "-", reason: p.reason });
        if (apply && p.changed) {
          guard.require("price-change");
          const live = acp(["offering", "list"]);
          const target = (Array.isArray(live) ? live : live.data || []).find((x) => x.name === o.name);
          if (target) acp(["offering", "update", "--offering-id", target.id, "--price-value", p.priceUsdc.toFixed(2)]);
          (store.state.priceHistory ??= []).push({ service: o.service, at: new Date().toISOString(), from: o.priceUsdc, to: p.priceUsdc, reason: p.reason, decision: "competitor" });
          o.priceUsdc = p.priceUsdc;
        }
      }
      console.table(rows);
      if (apply) {
        store.addSignal({ kind: "pricing_run", detail: JSON.stringify(rows.map((r) => [r.service, r.current, r.proposed])) });
      } else console.log("※ 적용: 'price-change' 승인 후 --apply");
      break;
    }
    case "export-state": {
      const now = Date.now();
      const st = store.state;
      const out = {
        exportedAt: new Date().toISOString(),
        approvals: st.approvals.filter((a) => !a.revokedAt && (!a.expiresAt || Date.parse(a.expiresAt) > now)),
        priceHistory: st.priceHistory || [], launched: st.launched || [], versions: st.versions || {},
        backlog: (st.backlog || []).filter((b) => !b.doneAt), growth: (st.growth || []).slice(-4),
      };
      writeFileSync(arg || "state-export.json", JSON.stringify(out, null, 2) + "\n");
      console.log(`내보내기 완료: ${arg || "state-export.json"} (승인 ${out.approvals.length}, 가격이력 ${out.priceHistory.length}, 출시 ${out.launched.length})`);
      break;
    }
    case "import-state": {
      const inp = JSON.parse(readFileSync(arg, "utf8"));
      const st = store.state;
      const key = (a) => `${a.action}|${a.approvedAt}`;
      for (const a of inp.approvals || []) if (!st.approvals.some((x) => key(x) === key(a))) st.approvals.push({ ...a, note: `${a.note || ""} (imported ${inp.exportedAt})` });
      const hk = (h) => `${h.service}|${h.at}`;
      for (const h of inp.priceHistory || []) if (!(st.priceHistory ||= []).some((x) => hk(x) === hk(h))) st.priceHistory.push(h);
      for (const l of inp.launched || []) if (!(st.launched ||= []).some((x) => x.service === l.service)) st.launched.push(l);
      st.versions = { ...(inp.versions || {}), ...(st.versions || {}) };
      for (const b of inp.backlog || []) if (!(st.backlog ||= []).some((x) => x.title === b.title && x.service === b.service)) st.backlog.push(b);
      if (!(st.growth || []).length) st.growth = inp.growth || [];
      store.approvalsDirty = true;
      store.save();
      console.log(`가져오기 완료: 승인 ${st.approvals.length}, 가격이력 ${st.priceHistory.length}, 출시 ${st.launched.length}`);
      break;
    }
    default:
      console.log("사용법: approvals | approve <action> --by <이름> | revoke <action> | offerings [--apply] [--only <service>] | pricing [--apply] | metrics");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
