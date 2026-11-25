// Provider 런타임: ACP v2 이벤트(JobRoomEntry) 기반 상태머신
//   job.created → (requirement 메시지) 사전검증 → setBudget
//   job.funded  → 처리 → 자동검수 → submit
//   job.completed/rejected/expired → 정산·기록
// 이벤트 라인 형식은 `acp events listen --json` 출력과 동일: {jobId, chainId, status, roles, availableTools, entry}
import { resolveService, precheck, fulfil, registerOfferings } from "../services/index.js";

export class ProviderRuntime {
  constructor({ adapter, store, offerings, policy, log = console.log }) {
    this.adapter = adapter;
    this.store = store;
    this.offerings = offerings;
    this.policy = policy;
    this.log = log;
    this.queue = Promise.resolve();
    registerOfferings(offerings);
    this.self = null;
  }

  async start() {
    this.self = (await this.adapter.getAddress())?.toLowerCase() ?? null;
    this.store.setHeartbeat({ adapter: this.adapter.name, network: this.adapter.network, address: this.self, startedAt: new Date().toISOString(), state: "running" });
    await this.refreshWallet();
    await this.adapter.start((line) => this.enqueue(line));
    this.log(`[provider] started adapter=${this.adapter.name} network=${this.adapter.network} address=${this.self}`);
  }

  async stop() {
    await this.adapter.stop();
    await this.queue;
    this.store.setHeartbeat({ state: "stopped" });
  }

  async refreshWallet() {
    try {
      const w = await this.adapter.getWalletBalance();
      if (w) this.store.setWallet(w);
    } catch (e) {
      this.log(`[provider] wallet balance read failed: ${e.message}`);
    }
  }

  /** 이벤트 직렬 처리 (경쟁 조건 방지). 반환 promise로 테스트에서 대기 가능 */
  enqueue(line) {
    this.queue = this.queue.then(() => this.handle(line)).catch((e) => {
      this.log(`[provider] handler error: ${e.stack || e.message}`);
      this.store.addSignal({ kind: "runtime_error", detail: e.message });
    });
    return this.queue;
  }

  offeringFor(service) {
    return this.offerings.find((o) => o.service === service);
  }

  todayCount() {
    const d = new Date().toISOString().slice(0, 10);
    return Object.values(this.store.state.jobs).filter((j) => j.budgetSetAt?.startsWith(d)).length;
  }

  async handle(line) {
    const { jobId, chainId, entry } = line;
    if (!entry || jobId === undefined) return;
    const id = String(jobId);
    this.store.setHeartbeat({ lastEventAt: new Date().toISOString() });
    this.store.logEvent({ jobId: id, chainId, kind: entry.kind, type: entry.event?.type ?? entry.contentType });
    if (Array.isArray(line.roles) && line.roles.length && !line.roles.includes("provider")) return; // 판매자 역할 job만 처리

    if (entry.kind === "system") return this.onSystem(id, chainId, entry.event, line);
    if (entry.kind === "message" && entry.contentType === "requirement" && entry.from?.toLowerCase() !== this.self) return this.onRequirement(id, chainId, entry, line);
    if (entry.kind === "message" && entry.contentType !== "requirement" && entry.from?.toLowerCase() !== this.self && entry.content) {
      // 구매자 의견 수집 (피드백 엔진 입력)
      this.store.addFeedback({ jobId: id, service: this.store.job(id)?.service ?? null, source: "message", text: String(entry.content).slice(0, 1000) });
    }
  }

  async onSystem(id, chainId, ev, line) {
    const job = this.store.job(id);
    switch (ev.type) {
      case "job.created":
        if (!job) this.store.upsertJob(id, { chainId, status: "open", client: ev.client, expiredAt: ev.expiredAt });
        return;
      case "budget.set":
        if (job && job.status === "open") this.store.upsertJob(id, { status: "budget_set" });
        return;
      case "job.funded":
        return this.onFunded(id, chainId, ev, line);
      case "job.submitted":
        if (job && job.status !== "submitted" && job.status !== "completed") this.store.upsertJob(id, { status: "submitted" });
        return;
      case "job.completed": {
        if (!job || job.status === "completed") return;
        const price = job.price ?? 0;
        const fee = +(price * this.policy.protocolFeeRate).toFixed(6);
        this.store.upsertJob(id, { status: "completed", completedAt: new Date().toISOString(), grossUsdc: price, feeUsdc: fee, netUsdc: +(price - fee).toFixed(6) });
        this.store.addLedger({ jobId: id, service: job.service, type: "revenue", grossUsdc: price, feeUsdc: fee, netUsdc: +(price - fee).toFixed(6) });
        this.log(`[provider] job ${id} completed: +${price - fee} USDC (net)`);
        await this.refreshWallet();
        return;
      }
      case "job.rejected":
        if (job) this.store.upsertJob(id, { status: "rejected", failReason: ev.reason || "rejected" });
        if (job && job.status !== "declined") this.store.addFeedback({ jobId: id, service: job.service ?? null, source: "rejection", text: String(ev.reason || "rejected").slice(0, 1000) });
        return;
      case "job.expired":
        if (job && !["completed", "rejected"].includes(job.status)) this.store.upsertJob(id, { status: job.status === "declined" ? "declined" : "expired", expiredEvent: true });
        return;
    }
  }

  async decline(id, chainId, code, message, service = null) {
    // CLI에는 provider reject 명령이 없음 → 예산 미제시 + 사유 메시지 (구매자 자금 이동 없음, job은 만료)
    this.store.upsertJob(id, { status: "declined", failReason: `${code}: ${message}`, service });
    this.store.addSignal({ kind: code === "UNSUPPORTED" ? "unsupported_request" : "invalid_request", code, detail: message, service });
    try {
      await this.adapter.sendMessage(id, chainId, `Request declined (${code}): ${message}. No budget was proposed, so no funds are at risk.`);
    } catch (e) {
      this.log(`[provider] message send failed: ${e.message}`);
    }
  }

  async onRequirement(id, chainId, entry, line) {
    let job = this.store.job(id) || this.store.upsertJob(id, { chainId, status: "open" });
    if (job.status !== "open") return; // 멱등성: 중복/재전송 무시
    let req;
    try {
      req = JSON.parse(entry.content);
    } catch {
      req = entry.content;
    }
    let offeringName = null;
    try {
      offeringName = await this.adapter.getOfferingName(id, chainId);
    } catch { /* 보조 정보 */ }
    const service = resolveService(req, offeringName, this.offerings);
    const offering = service && this.offeringFor(service);
    if (!offering) return this.decline(id, chainId, "UNSUPPORTED", `Unsupported request${offeringName ? ` for offering "${offeringName}"` : ""}`);
    if (this.todayCount() >= this.policy.dailyJobCap) return this.decline(id, chainId, "CAPACITY", "Daily capacity reached, please retry tomorrow", service);

    const pre = precheck(service, req, this.policy.limits);
    if (!pre.ok) return this.decline(id, chainId, pre.code, pre.message, service);

    this.store.saveRequirement(id, req);
    const price = offering.priceUsdc;
    if (Array.isArray(line.availableTools) && line.availableTools.length && !line.availableTools.includes("setBudget")) {
      this.log(`[provider] job ${id}: setBudget not available yet (tools=${line.availableTools}) — will set anyway`);
    }
    await this.adapter.setBudget(id, chainId, price);
    this.store.upsertJob(id, { status: "budget_set", service, offeringName: offering.name, price, budgetSetAt: new Date().toISOString(), requirementBytes: Buffer.byteLength(entry.content || "") });
    this.log(`[provider] job ${id}: ${service} budget ${price} USDC proposed`);
  }

  async onFunded(id, chainId, ev, line) {
    const job = this.store.job(id);
    if (!job || job.status === "submitted" || job.status === "completed") return;
    if (job.status === "declined") return; // 예산 미제시 job은 펀딩될 수 없음
    if (ev.amount !== undefined && job.price !== undefined && Number(ev.amount) + 1e-9 < job.price) {
      this.store.addSignal({ kind: "underfunded", detail: `job ${id} funded ${ev.amount} < ${job.price}` });
    }
    this.store.upsertJob(id, { status: "funded", fundedAt: new Date().toISOString(), fundedAmount: ev.amount });
    const req = this.store.loadRequirement(id);
    const started = Date.now();
    const res = req ? fulfil(id, job.service, req, this.policy.limits) : { ok: false, code: "LOST_REQUIREMENT", message: "requirement not found" };
    const aiCostUsd = this.policy.costs.aiCostPerJobUsd || 0;
    if (aiCostUsd) this.store.addLedger({ jobId: id, service: job.service, type: "cost", category: "ai", usd: aiCostUsd });

    if (!res.ok) {
      // 납품 불가 → 정직한 실패 보고서 제출: 구매자가 reject하면 에스크로 환불
      const notice = JSON.stringify({ service: job.service, jobId: id, status: "failed", code: res.code, message: res.message, refundRequested: true });
      await this.adapter.submit(id, chainId, notice);
      this.store.upsertJob(id, { status: "failed", failReason: `${res.code}: ${res.message}`, processingMs: Date.now() - started, aiCostUsd });
      this.store.addSignal({ kind: "processing_failed", code: res.code, detail: res.message, service: job.service });
      return;
    }
    await this.adapter.submit(id, chainId, res.deliverable.text);
    this.store.upsertJob(id, { status: "submitted", submittedAt: new Date().toISOString(), processingMs: Date.now() - started, deliverableSha256: res.deliverable.sha256, deliverableBytes: Buffer.byteLength(res.deliverable.text), qaPassed: res.qa.passed, aiCostUsd });
    this.log(`[provider] job ${id}: delivered (${Buffer.byteLength(res.deliverable.text)}B, qa=${res.qa.passed})`);
  }
}
