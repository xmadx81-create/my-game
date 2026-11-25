# ACP 상시 운영 서버 구축 기획서 (최소비용)

- 작성일: 2026-11-25
- 목적: Claude 클라우드 세션이 종료되거나 컨테이너가 재시작되어도 판매·성장 시스템이 24시간 계속 동작하도록 한다.
- 근거: 2026-11-25 22:36 UTC에 클라우드 컨테이너가 재시작되어 provider가 정지했다(실제 발생 사례).

## 1. 결론

| 항목 | 결정 |
|---|---|
| 1순위 | **Google Cloud e2-micro 상시 무료 등급 → 월 0원** (조건 충족 시) |
| 대안 | 유료 소형 VPS, 월 약 $3.5~6 (Vultr·Contabo·Hetzner x86 1GB 이상) |
| 제외 | ARM 서버 전부 (Oracle A1 무료형, Hetzner CAX 등). 공식 acp-cli 서명 프로그램이 **x86-64 전용**이라 거래 서명이 불가능함을 직접 확인했다 |
| 준비 상태 | 설치 스크립트·관리 명령·자동 업데이트·장애 복구·백업 개발 완료. 실제 설치 시험 통과 (Ubuntu 24.04 x86_64) |

## 2. 서버 요구사항 (실측 기준)

| 항목 | 실측값 / 요구값 |
|---|---|
| 메모리 | 상시 약 185MB (provider 50MB + 이벤트 리스너 134MB), 명령 실행 시 일시적으로 +130MB → **1GB면 충분** (스왑 1GB 추가) |
| CPU | 대부분 유휴 상태. 주문 처리는 결정적 연산으로 밀리초 단위 |
| 디스크 | 코드·라이브러리 약 360MB + 데이터 수 MB → 10GB 이상 |
| 네트워크 | 외부로 나가는 HTTPS만 사용. **외부에서 들어오는 포트는 불필요** (보안상 유리) |
| 아키텍처 | **x86_64 필수** |
| 월 트래픽 (추정) | 1GB 미만 (지갑 조회 10분 간격, 이벤트 스트림, 주간 시장조사) |

## 3. 서버 후보 비교

※ 가격과 무료 조건은 자주 바뀝니다. 가입 시점에 공식 페이지에서 **반드시 재확인**하십시오.

| 후보 | 월 비용 | 사양 | 적합성 | 비고 |
|---|---|---|---|---|
| **GCP e2-micro (Always Free)** | **0원** | 공유 vCPU 2, RAM 1GB, 표준 디스크 30GB, 미국 리전(us-west1·us-central1·us-east1) | ✅ 추천 | 카드 등록 필요. 무료 한도 초과분만 과금. 북미발 송신 1GB/월 무료 |
| Oracle E2.1.Micro (Always Free, x86) | 0원 | 1/8 OCPU, RAM 1GB | △ | **유휴 회수 정책** (7일간 CPU 95분위 20% 미만이면 회수 가능). 우리 서비스는 대부분 유휴 상태라 위험 |
| Oracle A1 (ARM, 무료) | 0원 | 2 OCPU / 12GB (2026년 축소) | ❌ | ARM이라 서명 불가 |
| Vultr Regular | 약 $3.5~6 | 512MB~1GB | ○ (유료 대안) | 512MB 요금제는 메모리가 빠듯하므로 1GB 권장 |
| Contabo Cloud VPS 10 | 약 €4.5 | 고사양 | ○ | 기본 외 리전은 추가요금 |
| Hetzner CX23 (x86) | 약 €5.49~5.99 | 2 vCPU / 4GB | ○ | 2026년 품절 표시 사례 있음. CAX(ARM)는 불가 |
| 관리자 개인 PC | 전기료 | - | △ | 24시간 가동·절전·재부팅 관리 부담 |

## 4. 운영 구조

```
[GCP e2-micro / Ubuntu 24.04]
 ├─ acp-provider.service  : 판매·주문처리·주간 성장 사이클 (장애 시 자동 재시작, 메모리 상한 700MB)
 ├─ acp-update.timer (6시간): ① 운영상태 백업(14일 보관) ② GitHub 브랜치 새 코드 → 테스트 통과 시만 반영, 실패 시 자동 복구
 │                            ③ 1시간 이상 무응답이면 재시작
 ├─ /var/lib/acp          : 운영 상태(가격 이력·출시 상품·승인·주문) — 코드 업데이트와 분리
 └─ /home/acp (권한 700)   : 로그인 토큰·서명키 (파일 키링)

[Claude 주간 점검 (월 09:47 KST)] → 개선 코드를 브랜치에 push → 서버가 6시간 안에 자동 반영
[주간 성장 보고서] → 에이전트 메일함 → 관리자 메일 (선택, REPORT_EMAIL)
```

## 5. 구축 절차 (관리자 작업 약 20분)

| 단계 | 작업 | 수행 |
|---|---|---|
| ① | Google Cloud 가입 (https://console.cloud.google.com) 및 결제 계정 등록 | 관리자 |
| ② | **예산 알림 설정**: 결제 → 예산 및 알림 → 예산 $1, 알림 50·90·100% (무료 한도 초과 즉시 인지) | 관리자 |
| ③ | Compute Engine → VM 인스턴스 만들기: 이름 `acp-provider` / 리전 `us-central1` / 머신 `e2-micro` / 부팅 디스크 **Ubuntu 24.04 LTS (x86/64)**, **표준 영구 디스크 30GB** / 방화벽 HTTP·HTTPS 체크 해제 | 관리자 |
| ④ | VM 목록에서 **SSH** 버튼 클릭 → 브라우저 터미널에 설치 명령 1줄 붙여넣기 (아래) | 관리자 |
| ⑤ | `sudo acpctl login` → 표시된 링크 클릭 (Virtuals 로그인) | 관리자 클릭 |
| ⑥ | `sudo acpctl signer` → 표시된 링크 클릭 (서명키 승인, 정책 Virtuals Only) | 관리자 클릭 |
| ⑦ | `sudo acpctl start` → 판매 시작 | 관리자 |
| ⑧ | Claude에게 **"서버 가동 완료"** 전달 → 클라우드 쪽 provider 중지(중복 처리 방지), 주간 점검 작업을 서버 운영 방식으로 전환 | Claude |
| ⑨ | (선택) `sudo acpctl email` → `/etc/acp-commerce.env`의 `REPORT_EMAIL=`에 수신 메일 입력 → `sudo acpctl restart` | 관리자 |

**설치 명령 (④ 단계에서 붙여넣기)**

```bash
curl -fsSL https://raw.githubusercontent.com/xmadx81-create/my-game/ccr-704e5dcf-f8lanv/acp-commerce/deploy/install.sh | sudo bash
```

**운영 명령**

| 명령 | 용도 |
|---|---|
| `sudo acpctl status` | 가동 상태·주문·지갑·상품·승인 현황 |
| `sudo acpctl logs` | 최근 로그 100줄 |
| `sudo acpctl report` | 최신 주간 성장 보고서 |
| `sudo acpctl update` | 코드 업데이트·점검 즉시 실행 |
| `sudo acpctl stop` / `start` | 판매 중지·재개 |

## 6. 비용 계획

| 구분 | 금액 | 조건 |
|---|---|---|
| 초기 비용 | 0원 | |
| 월 서버비 | **0원** | e2-micro 1대, 미국 3개 리전 중 1곳, 표준 디스크 30GB 이하, 북미발 송신 1GB 이하 |
| 공인 IPv4 | 0원 (확인 필요) | 무료 등급 안내상 e2-micro의 외부 IP는 비과금. 가입 시 결제 화면에서 확인 |
| 과금 위험 | 수백 원 수준 | 한도를 초과하면 초과분만 과금 → ② 예산 알림으로 즉시 인지 |
| 전환 기준 | - | 월 순매출이 서버비 대안($5)의 3배(약 $15)를 넘고 성능이 부족할 때 유료 VPS 검토 |

## 7. 위험과 대응

| 위험 | 대응 |
|---|---|
| provider 2개가 동시에 실행되어 같은 주문을 중복 처리 | 서버 가동 직후 클라우드 provider 중지 (⑧) |
| 서버 서명키 유출 | 외부 접속 포트 없음, 키 파일은 acp 계정 전용(권한 700), 정책 Virtuals Only로 ACP 계약 외 송금 차단, 에이전트 지갑 잔액은 소액 유지, 출금은 관리자 수동 |
| 잘못된 코드 자동 배포 | 테스트 38건이 통과해야 반영되고, 실패하면 자동으로 이전 버전 복구 |
| 서버 장애·재부팅 | systemd 자동 재시작, 6시간 주기 상태 점검, 일일 백업 14일 보관 |
| 무료 조건 변경 | 예산 알림 + 대안 VPS에 같은 설치 명령으로 이전 가능 (x86 Ubuntu면 동일) |
| 클라우드 세션 서명키 잔존 | 서버 전환 후 Virtuals 대시보드 → Signers에서 기존 서명키 철회 (관리자) |

## 8. 확인 필요사항

1. GCP 무료 등급 조건(리전·디스크 유형·외부 IP 과금 여부)은 가입 시점 공식 페이지 기준으로 재확인해야 합니다.
2. 결제 수단(카드) 등록이 필요합니다. 개인 카드 사용 여부는 관리자가 결정합니다(회사 자산 사용 금지 원칙).
3. 관제 화면(8787 포트)은 보안상 서버 내부에서만 열립니다. 원격 확인은 `acpctl status`와 주간 메일 보고로 대신합니다.

## 출처

- GCP 무료 등급: https://docs.cloud.google.com/free
- Oracle Always Free: https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm , https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- VPS 가격 비교: https://www.eucloudcost.com/compare/contabo-vs-hetzner/ , https://costgoat.com/pricing/hetzner , https://www.hostinger.com/tutorials/best-vps-hosting/
