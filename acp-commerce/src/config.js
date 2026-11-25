import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
