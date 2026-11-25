#!/usr/bin/env bash
# ACP provider 서버 설치 스크립트
#   대상: Ubuntu 22.04/24.04 LTS, x86_64 (공식 acp-cli 서명 프로그램이 x86-64 전용 → ARM 서버 불가)
#   사용: curl -fsSL https://raw.githubusercontent.com/xmadx81-create/my-game/ccr-704e5dcf-f8lanv/acp-commerce/deploy/install.sh | sudo bash
#   재실행해도 안전(멱등). DRY_RUN=1 이면 실행할 명령만 출력.
set -euo pipefail

REPO="${REPO:-https://github.com/xmadx81-create/my-game.git}"
BRANCH="${BRANCH:-ccr-704e5dcf-f8lanv}"
AGENT_ID="${AGENT_ID:-01a2148d-e846-72aa-b3ec-c3adbb6d3ea1}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_USER=acp
APP_DIR=/opt/acp/repo
DATA_DIR=/var/lib/acp
ENV_FILE=/etc/acp-commerce.env
DRY_RUN="${DRY_RUN:-0}"
SKIP_SWAP="${SKIP_SWAP:-0}"        # 컨테이너 시험용
SKIP_SYSTEMD="${SKIP_SYSTEMD:-0}"  # 컨테이너 시험용

say() { printf '\n\033[1m[설치] %s\033[0m\n' "$*"; }
run() { echo "+ $*"; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }

[ "$(uname -m)" = "x86_64" ] || { echo "오류: x86_64 서버만 지원합니다 (현재 $(uname -m)). ARM(Ampere/Graviton/CAX)은 acp-cli 서명 프로그램이 동작하지 않습니다."; exit 1; }
[ "$DRY_RUN" = 1 ] || [ "$(id -u)" -eq 0 ] || { echo "오류: sudo로 실행하세요."; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "경고: Ubuntu가 아닙니다(${ID:-unknown}). 계속 진행합니다."

say "1/7 스왑 1GB 설정 (메모리 1GB 서버 대비)"
if [ "$SKIP_SWAP" = 1 ]; then echo "건너뜀 (SKIP_SWAP=1)"
elif ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
  run fallocate -l 1G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || run sh -c "echo '/swapfile none swap sw 0 0' >> /etc/fstab"
else echo "이미 설정됨"; fi

say "2/7 기본 패키지"
run apt-get update -y
run env DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates xz-utils

say "3/7 Node.js ${NODE_MAJOR} LTS (nodejs.org 공식 배포본, SHA256 검증)"
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp=$(mktemp -d)
  run curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  if [ "$DRY_RUN" != 1 ]; then
    file=$(grep -oE "node-v[0-9.]+-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
  fi
  rm -rf "$tmp"
fi
[ "$DRY_RUN" = 1 ] || /usr/local/bin/node -v

say "4/7 실행 계정·디렉터리"
id "$APP_USER" >/dev/null 2>&1 || run useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
run mkdir -p /opt/acp "$DATA_DIR/backups"
run chown -R "$APP_USER:$APP_USER" /opt/acp "$DATA_DIR"
run chmod 700 "$DATA_DIR" /home/$APP_USER

say "5/7 코드 내려받기·설치·테스트 (브랜치 $BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  run runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch -q origin "$BRANCH"
  run runuser -u "$APP_USER" -- git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  run runuser -u "$APP_USER" -- git clone -q --depth 50 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
run runuser -u "$APP_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/$APP_USER npm --prefix "$APP_DIR/acp-commerce" ci --no-audit --no-fund
run runuser -u "$APP_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/$APP_USER npm --prefix "$APP_DIR/acp-commerce" test

say "6/7 환경설정·운영 상태 이전"
if [ ! -f "$ENV_FILE" ]; then
  [ "$DRY_RUN" = 1 ] || cat > "$ENV_FILE" <<EOF
# ACP provider 환경설정 (비밀값 없음. 로그인 토큰·서명키는 /home/acp 키링 파일에 저장)
ACP_DATA_DIR=$DATA_DIR
TS_KEYRING_BACKEND=file
HOME=/home/$APP_USER
NODE_NO_WARNINGS=1
AGENT_ID=$AGENT_ID
BRANCH=$BRANCH
# 주간 성장 보고서를 받을 메일 주소 (선택, 예: REPORT_EMAIL=you@example.com)
REPORT_EMAIL=
EOF
  echo "생성: $ENV_FILE"
fi
if [ ! -f "$DATA_DIR/state.json" ] && [ -f "$APP_DIR/acp-commerce/deploy/bootstrap-state.json" ]; then
  run runuser -u "$APP_USER" -- env ACP_DATA_DIR=$DATA_DIR /usr/local/bin/node "$APP_DIR/acp-commerce/src/bin/admin.js" import-state "$APP_DIR/acp-commerce/deploy/bootstrap-state.json"
fi

say "7/7 서비스 등록 (자동 재시작·6시간마다 업데이트/점검/백업)"
if [ "$SKIP_SYSTEMD" = 1 ]; then echo "건너뜀 (SKIP_SYSTEMD=1)"; run install -m 0755 "$APP_DIR/acp-commerce/deploy/acpctl" /usr/local/bin/acpctl; exit 0; fi
run install -m 0644 "$APP_DIR/acp-commerce/deploy/systemd/acp-provider.service" /etc/systemd/system/
run install -m 0644 "$APP_DIR/acp-commerce/deploy/systemd/acp-update.service" /etc/systemd/system/
run install -m 0644 "$APP_DIR/acp-commerce/deploy/systemd/acp-update.timer" /etc/systemd/system/
run install -m 0755 "$APP_DIR/acp-commerce/deploy/acpctl" /usr/local/bin/acpctl
run chmod 0755 "$APP_DIR/acp-commerce/deploy/acp-update.sh"
run systemctl daemon-reload
run systemctl enable acp-provider.service
run systemctl enable --now acp-update.timer
# 저널 로그 용량 제한 (디스크 보호)
run mkdir -p /etc/systemd/journald.conf.d
[ "$DRY_RUN" = 1 ] || printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/acp.conf
run systemctl restart systemd-journald

cat <<'EOF'

==================================================================
 설치 완료. 다음 3단계만 진행하세요 (각 단계에서 나오는 링크를 클릭):
   sudo acpctl login     ← Virtuals 로그인 (메인넷 계정)
   sudo acpctl signer    ← 이 서버용 서명키 승인 (정책: Virtuals Only)
   sudo acpctl start     ← 판매 시작
 상태 확인: sudo acpctl status   /  로그: sudo acpctl logs
 ※ 판매 시작 후 Claude에게 "서버 가동 완료"라고 알려 클라우드 쪽 provider를 중지하세요 (중복 처리 방지).
==================================================================
EOF
