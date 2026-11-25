// 서비스 레지스트리: 오퍼링 이름 → 처리기. 요구사항 구조로 서비스 추론(이벤트에 오퍼링명이 없을 때 대비)
import { runClean } from "./clean.js";
import { runTransform } from "./transform.js";
import { runValidate } from "./validate.js";
import { qaCheck, buildDeliverable } from "./qa.js";
import { ServiceError } from "./common.js";
import { applyPreset } from "../growth/catalog.js";

export const SERVICE_VERSION = "1.0.0";

export const SERVICES = {
  "data-clean": runClean,
  "data-transform": runTransform,
  "data-validate": runValidate,
};

/** 프리셋 상품 레지스트리: service → {engine, preset} (기존 엔진 재사용 상품) */
const PRESETS = new Map();
export function registerOfferings(offerings) {
  for (const o of offerings) if (o.engine && SERVICES[o.engine]) PRESETS.set(o.service, { engine: o.engine, preset: o.preset || {} });
}
export function engineOf(service) {
  return SERVICES[service] ? service : PRESETS.get(service)?.engine ?? null;
}
function runnerFor(service) {
  if (SERVICES[service]) return SERVICES[service];
  const p = PRESETS.get(service);
  if (!p) return null;
  return (req, limits) => SERVICES[p.engine](applyPreset(req, p.preset), limits);
}

/** 서비스 식별: ① 요구사항의 service 필드 ② 온체인 오퍼링명(job description) ③ 구조 추론 */
export function resolveService(requirement, offeringName, offerings) {
  if (requirement && typeof requirement.service === "string" && runnerFor(requirement.service)) return requirement.service;
  if (offeringName) {
    const o = offerings.find((x) => x.name === offeringName);
    if (o) return o.service;
  }
  if (requirement && typeof requirement === "object") {
    if (requirement.schema !== undefined || requirement.maxErrors !== undefined) return "data-validate";
    if (Array.isArray(requirement.operations) || (requirement.outputFormat && !requirement.options)) return "data-transform";
    if (requirement.data !== undefined) return "data-clean";
  }
  return null;
}

/** 요구사항 사전 검증 (예산 제시 전 실행 → 처리 불가 주문은 자금 이동 전 차단) */
export function precheck(service, requirement, limits) {
  try {
    const run = runnerFor(service);
    if (!run) throw new ServiceError("UNSUPPORTED", `Unsupported service: ${service}`);
    const result = run(requirement, limits);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, code: e.code || "INTERNAL", message: e.message };
  }
}

export function fulfil(jobId, service, requirement, limits) {
  const pre = precheck(service, requirement, limits);
  if (!pre.ok) return pre;
  const qa = qaCheck(engineOf(service) || service, pre.result, limits);
  if (!qa.passed) return { ok: false, code: "QA_FAILED", message: "Self-QA failed", qa };
  const deliverable = buildDeliverable({ jobId, service, version: SERVICE_VERSION, result: pre.result, qa });
  return { ok: true, deliverable, qa, summary: pre.result.summary };
}
