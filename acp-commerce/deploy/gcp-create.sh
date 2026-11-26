#!/usr/bin/env bash
# Google Cloud Shell에서 한 줄로 실행: 무료 등급 VM 생성 → 설치 → 로그인·서명키·판매 시작까지 자동 진행
#   curl -fsSL https://raw.githubusercontent.com/xmadx81-create/my-game/ccr-704e5dcf-f8lanv/acp-commerce/deploy/gcp-create.sh | bash
# 무료 등급 조건: e2-micro 1대, us-central1, 표준 영구 디스크 30GB, x86 Ubuntu 24.04 (가입 시 공식 조건 재확인)
set -uo pipefail

VM=acp-provider
ZONE="${ZONE:-us-central1-a}"
BRANCH="${BRANCH:-ccr-704e5dcf-f8lanv}"
INSTALL_URL="https://raw.githubusercontent.com/xmadx81-create/my-game/$BRANCH/acp-commerce/deploy/install.sh"
DRY_RUN="${DRY_RUN:-0}"
G() { echo "+ gcloud $*"; [ "$DRY_RUN" = 1 ] || gcloud "$@"; }
step() { printf '\n\033[1;34m[%s] %s\033[0m\n' "$1" "$2"; }
fail() { printf '\n\033[1;31m중단: %s\033[0m\n' "$*"; exit 1; }

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
PROJECT="${PROJECT:-yongpari-1dbfa}"
step 1/6 "프로젝트 설정: $PROJECT"
G config set project "$PROJECT" >/dev/null 2>&1

step 2/6 "Compute Engine 사용 설정 (최대 2분)"
if ! G services enable compute.googleapis.com; then
  fail "Compute Engine을 켤 수 없습니다. 대부분 결제 계정 미연결이 원인입니다.
  → https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT 에서 결제 계정을 연결한 뒤 같은 명령을 다시 실행하세요."
fi

step 3/6 "예산 알림 설정 (월 1,500원 / 50·90·100%, 실패해도 계속 진행)"
BA=$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##')
if [ -n "$BA" ]; then
  CUR=$(gcloud billing accounts describe "$BA" --format='value(currencyCode)' 2>/dev/null)
  AMT=$([ "$CUR" = "KRW" ] && echo 1500KRW || echo "1${CUR:-USD}")
  G services enable billingbudgets.googleapis.com >/dev/null 2>&1
  if gcloud billing budgets list --billing-account="$BA" --format='value(displayName)' 2>/dev/null | grep -q '^acp-budget$'; then echo "이미 있음"
  else G billing budgets create --billing-account="$BA" --display-name=acp-budget --budget-amount="$AMT" \
         --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 >/dev/null 2>&1 \
       && echo "예산 알림 생성: $AMT" || echo "※ 예산 알림 자동 생성 실패 → 콘솔 ☰ 결제 > 예산 및 알림에서 직접 설정해 주세요"
  fi
else echo "※ 결제 계정을 확인하지 못했습니다 (예산 알림은 콘솔에서 직접 설정)"; fi

step 4/6 "VM 생성: $VM (e2-micro / $ZONE / Ubuntu 24.04 x86 / 표준 디스크 30GB / 외부 접속 포트 없음)"
if gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then echo "이미 있음 → 재사용"
else
  G compute instances create "$VM" --zone="$ZONE" --machine-type=e2-micro \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --no-service-account --no-scopes || fail "VM 생성 실패 (위 오류 메시지를 Claude에게 전달해 주세요)"
fi
echo "SSH 준비 대기..."
for i in $(seq 1 30); do
  [ "$DRY_RUN" = 1 ] && break
  gcloud compute ssh "$VM" --zone "$ZONE" --quiet --command true >/dev/null 2>&1 && break
  sleep 10
done

step 5/6 "서버 설치 (약 5~10분, 끝날 때까지 창을 닫지 마세요)"
G compute ssh "$VM" --zone "$ZONE" --quiet --command "curl -fsSL $INSTALL_URL | sudo bash" || fail "설치 실패 (마지막 20줄을 Claude에게 전달해 주세요)"

step 6/6 "Virtuals 로그인 → 서명키 승인 → 판매 시작 (링크 2개를 차례로 클릭)"
G compute ssh "$VM" --zone "$ZONE" --quiet --command "sudo acpctl login && sudo acpctl signer && sudo acpctl start && sudo acpctl status" -- -t \
  || fail "로그인/서명 단계 중단. 다시: gcloud compute ssh $VM --zone $ZONE --command 'sudo acpctl login' -- -t"

printf '\n\033[1;32m완료! 위 status 결과를 복사해 Claude에게 "서버 가동 완료"와 함께 보내주세요.\033[0m\n'
echo "서버 접속: gcloud compute ssh $VM --zone $ZONE   /   상태: sudo acpctl status"
