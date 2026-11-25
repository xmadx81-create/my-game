import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, toOffering } from "./growth/catalog.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(ROOT, "config", f), "utf8"));

export function loadConfig() {
  return {
    offerings: read("offerings.json"),
    policy: read("policy.json"),
    candidates: read("candidates.json"),
    dataDir: process.env.ACP_DATA_DIR ? resolve(process.env.ACP_DATA_DIR) : join(ROOT, "data"),
  };
}

/**
 * 운영 중 변경사항(가격·자동 출시 상품)을 저장소 설정 위에 덧씌운다.
 * 저장소 config/offerings.json = 상품 정의(코드 업데이트로 갱신), data/state.json = 운영 상태(서버에만 존재)
 * → 서버가 git pull로 코드를 업데이트해도 가격·출시 이력이 유지된다.
 */
export function applyRuntimeOverlay(cfg, state) {
  const offerings = cfg.offerings.map((o) => ({ ...o, basePriceUsdc: o.basePriceUsdc ?? o.priceUsdc }));
  for (const l of state.launched || []) {
    if (offerings.some((o) => o.service === l.service)) continue;
    const c = CATALOG.find((x) => x.service === l.service && x.status === "ready");
    if (c) offerings.push(toOffering(c));
  }
  const last = {};
  for (const h of state.priceHistory || []) last[h.service] = h;
  for (const o of offerings) if (last[o.service]) o.priceUsdc = last[o.service].to;
  cfg.offerings.splice(0, cfg.offerings.length, ...offerings);
  return cfg;
}
