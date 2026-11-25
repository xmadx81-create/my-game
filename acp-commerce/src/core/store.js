// 경량 JSON 파일 저장소 (DB 비용 0). 원자적 쓰기(tmp→rename)로 중단 시 손상 방지
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EMPTY = () => ({ jobs: {}, ledger: [], signals: [], approvals: [], heartbeat: null, wallet: null, feedback: [], priceHistory: [], growth: [], launched: [] });

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "state.json");
    this.eventLog = join(dir, "events.ndjson");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "requirements"), { recursive: true });
    this.state = existsSync(this.file) ? { ...EMPTY(), ...JSON.parse(readFileSync(this.file, "utf8")) } : EMPTY();
  }

  /** 승인 기록은 관리자 도구(admin.js)가 소유 → 디스크 최신본을 읽어 온다 (다른 프로세스의 승인 유실 방지) */
  refreshApprovals() {
    if (this.approvalsDirty || !existsSync(this.file)) return this.state.approvals;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(disk.approvals)) this.state.approvals = disk.approvals;
    } catch { /* 파일 쓰기 중이면 기존 값 유지 */ }
    return this.state.approvals;
  }

  save() {
    this.refreshApprovals(); // 이 프로세스가 승인을 바꾸지 않았다면 디스크의 승인 기록을 보존
    this.approvalsDirty = false;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  reload() {
    if (existsSync(this.file)) this.state = { ...EMPTY(), ...JSON.parse(readFileSync(this.file, "utf8")) };
    return this.state;
  }

  logEvent(evt) {
    appendFileSync(this.eventLog, JSON.stringify({ at: new Date().toISOString(), ...evt }) + "\n");
  }

  job(jobId) {
    return this.state.jobs[jobId];
  }

  upsertJob(jobId, patch) {
    const now = new Date().toISOString();
    const cur = this.state.jobs[jobId] || { jobId, createdAt: now, history: [] };
    const next = { ...cur, ...patch, updatedAt: now };
    if (patch.status && patch.status !== cur.status) next.history = [...(cur.history || []), { status: patch.status, at: now }];
    this.state.jobs[jobId] = next;
    this.save();
    return next;
  }

  addLedger(entry) {
    this.state.ledger.push({ at: new Date().toISOString(), ...entry });
    this.save();
  }

  addSignal(signal) {
    this.state.signals.push({ at: new Date().toISOString(), ...signal });
    if (this.state.signals.length > 1000) this.state.signals = this.state.signals.slice(-1000);
    this.save();
  }

  addFeedback(fb) {
    this.state.feedback.push({ at: new Date().toISOString(), ...fb });
    if (this.state.feedback.length > 2000) this.state.feedback = this.state.feedback.slice(-2000);
    this.save();
  }

  setHeartbeat(hb) {
    this.state.heartbeat = { ...(this.state.heartbeat || {}), ...hb, at: new Date().toISOString() };
    this.save();
  }

  setWallet(w) {
    this.state.wallet = { ...w, at: new Date().toISOString() };
    this.save();
  }

  saveRequirement(jobId, req) {
    const p = join(this.dir, "requirements", `${String(jobId).replace(/[^\w.-]/g, "_")}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(req));
  }

  loadRequirement(jobId) {
    const p = join(this.dir, "requirements", `${String(jobId).replace(/[^\w.-]/g, "_")}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }
}
