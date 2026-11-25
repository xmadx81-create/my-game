#!/usr/bin/env bash
# 6시간마다 실행 (systemd acp-update.timer)
#  1) 운영 상태 백업 (일 1회, 14일 보관)
#  2) 코드 업데이트: 브랜치에 새 커밋이 있으면 받아서 테스트 → 통과 시 재시작, 실패 시 이전 버전으로 자동 복구
#  3) 상태 점검: provider가 멈췄거나 1시간 넘게 응답이 없으면 재시작
set -uo pipefail
ENV_FILE=/etc/acp-commerce.env
set -a; . "$ENV_FILE"; set +a
REPO=/opt/acp/repo
APP=$REPO/acp-commerce
as_acp() { runuser -u acp -- env PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/acp ACP_DATA_DIR="$ACP_DATA_DIR" TS_KEYRING_BACKEND=file "$@"; }
log() { echo "[acp-update] $*"; }

# 1) 백업
if [ -f "$ACP_DATA_DIR/state.json" ]; then
  today="$ACP_DATA_DIR/backups/state-$(date +%F).json"
  [ -f "$today" ] || { cp "$ACP_DATA_DIR/state.json" "$today" && chown acp:acp "$today" && log "backup $today"; }
  ls -1t "$ACP_DATA_DIR"/backups/state-*.json 2>/dev/null | tail -n +15 | xargs -r rm -f
fi

# 2) 코드 업데이트 (테스트 통과 시에만 반영)
old=$(as_acp git -C "$REPO" rev-parse HEAD)
if as_acp git -C "$REPO" fetch -q origin "$BRANCH"; then
  new=$(as_acp git -C "$REPO" rev-parse "origin/$BRANCH")
  if [ "$old" != "$new" ]; then
    log "update $old -> $new"
    as_acp git -C "$REPO" reset -q --hard "$new"
    if as_acp npm --prefix "$APP" ci --no-audit --no-fund >/dev/null 2>&1 && as_acp npm --prefix "$APP" test >/tmp/acp-test.log 2>&1; then
      install -m 0755 "$APP/deploy/acpctl" /usr/local/bin/acpctl
      for u in acp-provider.service acp-update.service acp-update.timer; do install -m 0644 "$APP/deploy/systemd/$u" /etc/systemd/system/; done
      systemctl daemon-reload
      systemctl is-enabled -q acp-provider && systemctl is-active -q acp-provider && systemctl restart acp-provider
      log "deployed $new (tests passed)"
    else
      log "tests FAILED for $new -> rollback to $old"; tail -20 /tmp/acp-test.log
      as_acp git -C "$REPO" reset -q --hard "$old"
      as_acp npm --prefix "$APP" ci --no-audit --no-fund >/dev/null 2>&1
    fi
  fi
else
  log "git fetch failed (network?) - skip update"
fi

# 3) 상태 점검 (지갑 잔액은 10분마다 갱신 → 1시간 이상 멈춰 있으면 비정상)
if systemctl is-active -q acp-provider; then
  stale=$(as_acp node -e '
    const s=JSON.parse(require("fs").readFileSync(process.env.ACP_DATA_DIR+"/state.json","utf8"));
    const t=Math.max(Date.parse(s.wallet?.at||0)||0, Date.parse(s.heartbeat?.lastEventAt||0)||0, Date.parse(s.heartbeat?.startedAt||0)||0);
    console.log(Date.now()-t > 3600e3 ? "yes" : "no")' 2>/dev/null || echo "unknown")
  if [ "$stale" = "yes" ]; then log "provider unresponsive > 1h -> restart"; systemctl restart acp-provider; fi
fi
