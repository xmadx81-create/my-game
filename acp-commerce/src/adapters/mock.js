// 모의 ACP 마켓플레이스 (테스트넷 대체 검증용)
// - 실제 ACP v2와 동일한 이벤트 라인/상태 전이(open→budget_set→funded→submitted→completed/rejected/expired)
// - USDC 잔액·에스크로·프로토콜 수수료(기본 20%)를 장부로 시뮬레이션 → 정산까지 검증
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");

export class MockMarketplace {
  constructor({ feeRate = 0.2, providerAddress = "0xprovider000000000000000000000000000000001", chainId = 84532 } = {}) {
    this.feeRate = feeRate;
    this.chainId = chainId;
    this.providerAddress = providerAddress;
    this.balances = new Map([[providerAddress, 0], ["0xtreasury", 0]]);
    this.escrow = new Map();
    this.jobs = new Map();
    this.nextId = 1000;
    this.listener = null;
    this.buyers = new Map();
    this.pending = 0;
    this.idleWaiters = [];
  }

  fundWallet(addr, usdc) {
    this.balances.set(addr, (this.balances.get(addr) || 0) + usdc);
  }

  balance(addr) {
    return +(this.balances.get(addr) || 0).toFixed(6);
  }

  // ---- 이벤트 전송 (비동기, 실제 소켓 지연 모사) ----
  emit(job, entry) {
    this.pending++;
    setImmediate(async () => {
      try {
        const roles = ["provider"];
        const line = { jobId: job.id, chainId: this.chainId, status: job.status, roles, availableTools: this.toolsFor(job, "provider"), entry };
        if (this.listener) await this.listener(line);
        const buyer = this.buyers.get(job.id);
        if (buyer) await buyer.onEntry(job, entry);
      } finally {
        this.pending--;
        if (this.pending === 0) this.idleWaiters.splice(0).forEach((r) => r());
      }
    });
  }

  idle() {
    return this.pending === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  toolsFor(job, role) {
    if (role !== "provider") return [];
    return { open: ["setBudget", "sendMessage"], budget_set: ["wait"], funded: ["submit"], submitted: ["wait"] }[job.status] || [];
  }

  sys(job, event) {
    this.emit(job, { kind: "system", onChainJobId: String(job.id), chainId: this.chainId, event: { jobId: String(job.id), ...event }, timestamp: Date.now() });
  }

  msg(job, from, contentType, content) {
    this.emit(job, { kind: "message", onChainJobId: String(job.id), chainId: this.chainId, from, contentType, content, timestamp: Date.now() });
  }

  // ---- 구매자(클라이언트) 측 ----
  createJob({ buyer, offeringName, requirement, autoFund = true, evaluate, slaMinutes = 10 }) {
    const id = String(this.nextId++);
    const job = { id, client: buyer, provider: this.providerAddress, description: offeringName, status: "open", budget: null, deliverable: null, expiredAt: new Date(Date.now() + slaMinutes * 60e3).toISOString() };
    this.jobs.set(id, job);
    this.buyers.set(id, {
      onEntry: async (j, entry) => {
        if (entry.kind !== "system") return;
        if (entry.event.type === "budget.set" && autoFund) this.fund(id, buyer);
        if (entry.event.type === "job.submitted") {
          const verdict = evaluate ? await evaluate(j.deliverable) : { ok: true, reason: "auto-approve" };
          verdict.ok ? this.complete(id, buyer, verdict.reason) : this.reject(id, buyer, verdict.reason);
        }
      },
    });
    this.sys(job, { type: "job.created", client: buyer, provider: this.providerAddress, evaluator: buyer, expiredAt: job.expiredAt, hook: "0x0" });
    this.msg(job, buyer, "requirement", typeof requirement === "string" ? requirement : JSON.stringify(requirement));
    return id;
  }

  fund(id, buyer) {
    const job = this.jobs.get(id);
    if (job.status !== "budget_set") throw new Error(`fund: invalid status ${job.status}`);
    if (this.balance(buyer) < job.budget) throw new Error("fund: insufficient USDC");
    this.balances.set(buyer, this.balance(buyer) - job.budget);
    this.escrow.set(id, job.budget);
    job.status = "funded";
    this.sys(job, { type: "job.funded", client: buyer, amount: job.budget });
  }

  complete(id, evaluator, reason) {
    const job = this.jobs.get(id);
    if (job.status !== "submitted") throw new Error(`complete: invalid status ${job.status}`);
    const amt = this.escrow.get(id);
    const fee = +(amt * this.feeRate).toFixed(6);
    this.balances.set(this.providerAddress, this.balance(this.providerAddress) + amt - fee);
    this.balances.set("0xtreasury", this.balance("0xtreasury") + fee);
    this.escrow.delete(id);
    job.status = "completed";
    this.sys(job, { type: "job.completed", evaluator, reason });
  }

  reject(id, rejector, reason) {
    const job = this.jobs.get(id);
    const amt = this.escrow.get(id) || 0;
    if (amt) this.balances.set(job.client, this.balance(job.client) + amt);
    this.escrow.delete(id);
    job.status = "rejected";
    this.sys(job, { type: "job.rejected", rejector, reason });
  }

  expire(id) {
    const job = this.jobs.get(id);
    if (["completed", "rejected", "expired"].includes(job.status)) return;
    const amt = this.escrow.get(id) || 0;
    if (amt) this.balances.set(job.client, this.balance(job.client) + amt);
    this.escrow.delete(id);
    job.status = "expired";
    this.sys(job, { type: "job.expired" });
  }

  // ---- 판매자(provider) 측 액션 (adapter가 호출) ----
  setBudget(id, amount) {
    const job = this.jobs.get(id);
    if (job.status !== "open") throw new Error(`setBudget: invalid status ${job.status}`);
    job.budget = amount;
    job.status = "budget_set";
    this.sys(job, { type: "budget.set", amount });
  }

  submit(id, deliverable) {
    const job = this.jobs.get(id);
    if (job.status !== "funded") throw new Error(`submit: invalid status ${job.status}`);
    job.deliverable = deliverable;
    job.status = "submitted";
    this.sys(job, { type: "job.submitted", provider: this.providerAddress, deliverable, deliverableHash: "0x" + sha(deliverable) });
  }
}

/** Provider 런타임이 사용하는 어댑터 (CLI 어댑터와 동일 인터페이스) */
export class MockAdapter {
  constructor(market) {
    this.market = market;
    this.name = "mock";
    this.network = "mock";
  }
  async getAddress() { return this.market.providerAddress; }
  async start(onEvent) { this.market.listener = onEvent; }
  async stop() { this.market.listener = null; }
  async setBudget(jobId, _chainId, amount) { this.market.setBudget(String(jobId), amount); }
  async submit(jobId, _chainId, deliverable) { this.market.submit(String(jobId), deliverable); }
  async sendMessage(jobId, _chainId, content) { const job = this.market.jobs.get(String(jobId)); this.market.msg(job, this.market.providerAddress, "text", content); }
  async getOfferingName(jobId) { return this.market.jobs.get(String(jobId))?.description ?? null; }
  async getWalletBalance() { return { source: "mock", chainId: this.market.chainId, usdc: this.market.balance(this.market.providerAddress) }; }
}
