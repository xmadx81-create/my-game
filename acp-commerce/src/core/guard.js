// 관리자 승인 가드: 메인넷 운영·오퍼링 등록·가격 변경·출금·충전·토큰발행·트레이딩은 승인 기록 없이는 실행 불가
// 원칙: 자체 토큰 발행/투기성 거래는 코드 경로 자체를 제공하지 않음(tokenize/trade는 영구 차단)

export const FORBIDDEN_ACTIONS = new Set(["tokenize", "trade"]); // 개발 원칙상 승인으로도 해제 불가

export class ApprovalRequired extends Error {
  constructor(action) {
    super(`관리자 승인 필요: "${action}" — node src/bin/admin.js approve ${action} --by <관리자명> 실행 후 재시도`);
    this.code = "APPROVAL_REQUIRED";
    this.action = action;
  }
}

export class Guard {
  constructor(store, policy) {
    this.store = store;
    this.policy = policy;
  }

  isApproved(action) {
    if (FORBIDDEN_ACTIONS.has(action)) return false;
    const now = Date.now();
    return this.store.refreshApprovals().some((a) => a.action === action && !a.revokedAt && (!a.expiresAt || Date.parse(a.expiresAt) > now));
  }

  require(action) {
    if (FORBIDDEN_ACTIONS.has(action)) {
      const e = new Error(`금지된 작업: "${action}" (개발 원칙: 자체 토큰 발행·투기성 거래 금지)`);
      e.code = "FORBIDDEN";
      throw e;
    }
    if (this.policy.requireApprovalFor.includes(action) && !this.isApproved(action)) throw new ApprovalRequired(action);
  }

  approve(action, by, { note = "", hours = 0 } = {}) {
    if (FORBIDDEN_ACTIONS.has(action)) throw new Error(`금지된 작업은 승인할 수 없습니다: ${action}`);
    if (!by) throw new Error("--by <관리자명> 필요");
    const rec = { action, approvedBy: by, note, approvedAt: new Date().toISOString(), expiresAt: hours ? new Date(Date.now() + hours * 3600e3).toISOString() : null };
    this.store.refreshApprovals();
    this.store.state.approvals.push(rec);
    this.store.approvalsDirty = true;
    this.store.save();
    return rec;
  }

  revoke(action) {
    let n = 0;
    this.store.refreshApprovals();
    this.store.approvalsDirty = true;
    for (const a of this.store.state.approvals) if (a.action === action && !a.revokedAt) (a.revokedAt = new Date().toISOString()), n++;
    this.store.save();
    return n;
  }
}
