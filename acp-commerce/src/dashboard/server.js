// 통합 관제 대시보드 (읽기 전용). 기본 127.0.0.1 바인딩, DASHBOARD_TOKEN 설정 시 토큰 인증
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMetrics } from "../core/metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function createDashboard({ store, offerings, policy, candidates, token = process.env.DASHBOARD_TOKEN }) {
  const html = readFileSync(join(HERE, "index.html"), "utf8");
  return createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (token) {
      const given = url.searchParams.get("token") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (given !== token) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        return res.end("인증 필요: ?token=... 또는 Authorization: Bearer");
      }
    }
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (url.pathname === "/api/metrics") {
      const state = store.reload();
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(computeMetrics(state, { offerings, policy, candidates })));
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { ...headers, "content-type": "text/plain" });
      return res.end("ok");
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    res.writeHead(404, headers);
    res.end();
  });
}
