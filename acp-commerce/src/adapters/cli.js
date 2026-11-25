// 실거래 어댑터: 공식 @virtuals-protocol/acp-cli(v1.0.40+)를 --json 모드로 호출
// - 이벤트: `acp events listen --output <file>` (단일 리스너) + `acp events drain` 폴링
// - 액션: provider set-budget / provider submit / message send
// - 안전장치: IS_TESTNET=true 가 아니면 관리자 'mainnet' 승인 없이는 기동 불가
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveBin() {
  if (process.env.ACP_BIN) return process.env.ACP_BIN;
  const local = join(ROOT, "node_modules", ".bin", "acp");
  return existsSync(local) ? local : "acp";
}

/** 프록시 환경에서 Node 내장 fetch가 HTTPS_PROXY를 따르도록 설정 (Node >= 22.21) */
export function cliEnv() {
  const env = { ...process.env };
  if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = "1";
  // 헤드리스 Linux: 토큰 저장은 파일 키링으로 폴백되나 조회 시 다른 백엔드가 선택되어 "Not authenticated" 발생 → 파일 백엔드 고정
  if (process.platform === "linux" && !env.TS_KEYRING_BACKEND && !env.DBUS_SESSION_BUS_ADDRESS) env.TS_KEYRING_BACKEND = "file";
  return env;
}

function deepFind(obj, pred, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return [];
  const out = pred(obj) ? [obj] : [];
  for (const v of Object.values(obj)) out.push(...deepFind(v, pred, depth + 1));
  return out;
}

export class CliAdapter {
  constructor({ guard, dataDir, pollMs = 3000, log = console.log }) {
    this.bin = resolveBin();
    this.name = "acp-cli";
    this.network = process.env.IS_TESTNET === "true" ? "testnet" : "mainnet";
    if (this.network === "mainnet") guard.require("mainnet"); // 승인 없으면 예외
    this.pollMs = pollMs;
    this.log = log;
    this.eventsFile = join(dataDir, "acp-events.jsonl");
    mkdirSync(dataDir, { recursive: true });
    this.offeringCache = new Map();
  }

  run(args, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(this.bin, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: cliEnv() }, (err, stdout, stderr) => {
        if (err) {
          let detail = stderr?.trim() || err.message;
          try { detail = JSON.parse(stderr.trim().split("\n").pop()).error || detail; } catch { /* plain text */ }
          return reject(new Error(`acp ${args.slice(0, 2).join(" ")} 실패: ${detail}`));
        }
        const text = stdout.trim();
        try { resolve(text ? JSON.parse(text.split("\n").filter(Boolean).pop()) : {}); } catch { resolve({ raw: text }); }
      });
    });
  }

  async getAddress() {
    const r = await this.run(["wallet", "address"]);
    return r.address || r.walletAddress || deepFind(r, (o) => typeof o.address === "string")[0]?.address || null;
  }

  async start(onEvent) {
    this.listener = spawn(this.bin, ["events", "listen", "--output", this.eventsFile, "--json"], { stdio: ["ignore", "ignore", "pipe"], env: cliEnv() });
    this.listener.stderr.on("data", (d) => this.log(`[acp listen] ${String(d).trim()}`));
    this.listener.on("exit", (code) => { this.log(`[acp listen] exited code=${code}`); this.listenerExited = true; });
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        if (existsSync(this.eventsFile)) {
          const r = await this.run(["events", "drain", "--file", this.eventsFile, "--limit", "20"]);
          for (const ev of r.events || []) await onEvent(ev);
        }
      } catch (e) {
        this.log(`[acp drain] ${e.message}`);
      }
      this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.listener?.kill("SIGTERM");
  }

  async setBudget(jobId, chainId, amount) {
    return this.run(["provider", "set-budget", "--job-id", String(jobId), "--amount", String(amount), "--chain-id", String(chainId)]);
  }

  async submit(jobId, chainId, deliverable) {
    return this.run(["provider", "submit", "--job-id", String(jobId), "--deliverable", deliverable, "--chain-id", String(chainId)]);
  }

  async sendMessage(jobId, chainId, content) {
    return this.run(["message", "send", "--job-id", String(jobId), "--chain-id", String(chainId), "--content", content]);
  }

  /** 온체인 job description(=오퍼링명) 조회. 출력 스키마 변경에 대비해 방어적으로 탐색 */
  async getOfferingName(jobId) {
    if (this.offeringCache.has(jobId)) return this.offeringCache.get(jobId);
    const r = await this.run(["job", "list"]);
    const hit = deepFind(r, (o) => String(o.jobId ?? o.id ?? o.onChainJobId) === String(jobId) && typeof o.description === "string")[0];
    const name = hit?.description ?? null;
    this.offeringCache.set(jobId, name);
    return name;
  }

  async getWalletBalance() {
    const r = await this.run(["wallet", "balance"]);
    const usdc = deepFind(r, (o) => /usdc/i.test(String(o.symbol ?? o.token ?? "")))
      .map((o) => ({ chainId: o.chainId ?? null, amount: Number(o.balance ?? o.amount ?? o.formatted ?? 0) }));
    return { source: "acp-cli", network: this.network, usdc: usdc.reduce((a, b) => a + (Number.isFinite(b.amount) ? b.amount : 0), 0), detail: usdc };
  }
}
