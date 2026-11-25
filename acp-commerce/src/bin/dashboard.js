#!/usr/bin/env node
// 대시보드 단독 실행: node src/bin/dashboard.js [port]
import { loadConfig } from "../config.js";
import { Store } from "../core/store.js";
import { createDashboard } from "../dashboard/server.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const port = Number(process.argv[2]) || 8787;
const host = process.env.DASHBOARD_HOST || "127.0.0.1";
createDashboard({ store, ...cfg }).listen(port, host, () => console.log(`[dashboard] http://${host}:${port}  (data: ${cfg.dataDir})`));
