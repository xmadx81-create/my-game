# ACP 자동 수익화 프로젝트 v1.0: 데이터 서비스 Provider

Virtuals **Agent Commerce Protocol(ACP) v2**에 연동하는 판매자(Provider) 에이전트입니다. 데이터 정제, 데이터 변환, 데이터 검수 3종을 자동으로 판매하고 USDC 에스크로로 정산받습니다.

- **초기 개발비 0원**: Node.js 내장 모듈만 사용하고, 외부 의존성은 공식 `@virtuals-protocol/acp-cli` 하나뿐입니다.
- **AI 호출비 0원**: 3종 모두 결정적(deterministic) 처리이며 LLM을 호출하지 않습니다.
- **안전장치**: 메인넷 기동, 오퍼링 등록, 가격 변경, 출금, 충전은 관리자 승인 기록이 있어야 실행됩니다. 토큰 발행과 트레이딩은 승인으로도 해제되지 않도록 코드 경로 자체를 막아 두었습니다.

## 1. 구성

| 경로 | 역할 |
|---|---|
| `src/services/` | 정제(`clean.js`), 변환(`transform.js`), 검수(`validate.js`), 납품 전 자동검수(`qa.js`) |
| `src/core/provider.js` | ACP 이벤트 상태머신: 주문 수신 → 사전검증 → 예산 제시 → 처리 → 검수 → 납품 → 정산 |
| `src/core/guard.js` | 관리자 승인 가드 |
| `src/core/store.js` | JSON 파일 저장소(`data/state.json`). DB 비용이 들지 않습니다 |
| `src/adapters/cli.js` | 실거래 어댑터. 공식 acp-cli를 `--json` 모드로 호출합니다 |
| `src/adapters/mock.js` | 모의 마켓. 에스크로, 수수료 20%, 만료, 거절까지 시뮬레이션합니다 |
| `src/dashboard/` | 통합 관제 화면(읽기 전용) |
| `config/offerings.json` | 판매 상품: 가격, SLA, 요구사항 JSON 스키마 |
| `config/policy.json` | 운영 정책: 한도, 수수료율, 승인 대상, 비용 |
| `config/candidates.json` | 신규 사업 후보 |

## 2. 판매 상품(초기가)

| 상품 | 단가(USDC) | 순수령(수수료 20% 차감) | SLA | 입력 한도 |
|---|---|---|---|---|
| Data Cleaning | 0.30 | 0.24 | 10분 | 1MB / 20,000행 |
| Data Transform | 0.25 | 0.20 | 10분 | 1MB / 20,000행 |
| Data Validation | 0.20 | 0.16 | 10분 | 1MB / 20,000행 |

※ 프로토콜 수수료 20%는 2026-03 2차 자료 기준이므로 **최신 공식 기준으로 재확인해야 합니다**.

## 3. 실행 방법

```bash
cd acp-commerce
npm install                      # 공식 acp-cli 1.0.40 설치
npm test                         # 자동 테스트 20건
npm run simulate                 # 모의 거래 전 흐름 검증 (11개 시나리오)
npm run simulate:dashboard       # 모의 데이터로 관제 화면 → http://127.0.0.1:8787
```

## 4. 테스트넷 개시 절차 (관리자 1회 조치 필요)

| 단계 | 실행 주체 | 내용 |
|---|---|---|
| ① | Claude 실행 → 관리자 클릭 | `IS_TESTNET=true npx acp configure start --json`로 발급된 로그인 URL을 관리자가 클릭합니다 (신규 개인 계정, 회사 자산 사용 금지) |
| ② | Claude | `acp configure complete --request-id <id> --json` |
| ③ | Claude | `acp agent create --name "<에이전트명>" --description "..."` |
| ④ | Claude 실행 → 관리자 클릭 | `acp agent add-signer --policy restricted --no-wait --json`로 발급된 승인 URL을 관리자가 클릭합니다 (ACP 계약 외 송금 차단 정책) |
| ⑤ | 관리자 | `node src/bin/admin.js approve register-offerings --by <이름>` |
| ⑥ | Claude | `IS_TESTNET=true node src/bin/admin.js offerings --apply` (오퍼링 3종 등록) |
| ⑦ | Claude | `npm run provider:testnet` (상주 실행 및 관제 화면) |
| ⑧ | Claude | 테스트넷 구매자 에이전트로 실거래 1회 이상 검증 (테스트넷 USDC 필요) |

메인넷 전환은 `node src/bin/admin.js approve mainnet --by <이름>` 승인을 받은 뒤 `IS_TESTNET` 없이 기동합니다. 승인이 없으면 기동이 거부됩니다.

## 5. 클라우드(헤드리스 Linux) 실행 시 환경변수

| 변수 | 값 | 이유 |
|---|---|---|
| `NODE_USE_ENV_PROXY` | `1` | Node 내장 fetch가 HTTPS_PROXY를 따르도록 (없으면 `fetch failed`) |
| `TS_KEYRING_BACKEND` | `file` | 로그인 토큰 조회 실패(`Not authenticated`) 방지 |

`src/adapters/cli.js`의 `cliEnv()`가 위 두 값을 자동으로 설정합니다. 직접 `acp` 명령을 실행할 때는 수동으로 지정해야 합니다.

## 6. 필요 네트워크 호스트

`api.acp.virtuals.io`, `api-dev.acp.virtuals.io`, `auth.privy.io`, `api.privy.io`, `alchemy-proxy*.virtuals.io`, `base-*.g.alchemy.com`, `sepolia.base.org`

이 호스트들은 현재 클라우드 환경 "깃"에 허용 등록되어 있습니다.

## 7. 운영 규칙 (구현 반영 사항)

1. **예산 제시 전 실제 처리를 한 번 시험 실행**합니다. 처리할 수 없는 주문은 예산을 제시하지 않고 사유 메시지만 보내므로 구매자 자금이 이동하지 않습니다.
2. **납품물**은 결과, 요약, 자동검수(QA) 결과, sha256 해시를 담은 JSON입니다. 구매자가 해시로 무결성을 검증할 수 있습니다.
3. 입금 후 처리에 실패하면 실패 보고서를 납품하고 환불(reject)을 유도합니다. 현행 CLI에는 provider용 reject 명령이 없기 때문입니다.
4. 이벤트는 직렬로 처리하고 상태를 기준으로 멱등성을 보장합니다. 같은 주문에 예산을 두 번 제시하지 않습니다.
5. 일일 처리 한도는 `dailyJobCap`(기본 500건)이며, 초과분은 사전 거절합니다.
6. 거절되거나 실패한 요청은 수요 신호로 집계해 관제 화면의 "신규 사업 후보" 판단에 활용합니다.

## 8. 자율 성장 시스템

| 기능 | 동작 | 자동 여부 |
|---|---|---|
| 가격 안전장치 (`src/growth/priceGuard.js`) | 하한(정책 0.05·원가·기준가 -30%), 1회 ±10%, 쿨다운 7일, 근거 없는 연속 인하 금지, 상한 기준가 ×2 | 모든 가격 변경에 강제 적용 |
| 피드백 엔진 (`src/growth/feedback.js`) | 구매자 메시지·거절 사유·사전거절·실패를 분류 → **보완(patch)**: 품질 결함, 가격 동결 / **업그레이드(upgrade)**: 같은 요청 28일 3회 이상, 출시 후 +1단계 / **성장(grow)**: 주 20건 이상·성공률 95% 이상이면 +1단계 / 가격 불만 반복 또는 장기 무주문+경쟁 저가면 -1단계 | 판단·가격은 자동 (`price-change` 승인 범위) |
| 주간 시장조사 (`src/growth/research.js`) | 26개 검색어 스냅샷, 카테고리별 공급·가격·실적, 전주 대비 변화, 고객 니즈 키워드 | 자동 (7일 주기) |
| 신상품 (`src/growth/catalog.js`) | 기존 엔진 프리셋 상품(ready)은 점수순으로 **주 1개 자동 출시**, 새 엔진이 필요한 후보는 백로그로 | 자동 (`auto-launch` 승인 범위) |
| 자산관리 (`src/growth/treasury.js`) | 잔액·예비금·가용 자금, 수익 증대 **제안**만 생성 | 지출은 항상 관리자 승인 후 수동 |
| 코드 개선 | 백로그의 보완·업그레이드·새 엔진을 매주 구현·테스트·배포 | 주간 점검 예약 작업(Claude, 월 09:47 KST) |

```bash
node src/bin/growth.js --dry-run   # 성장 사이클 모의 실행 (변경 없음)
node src/bin/growth.js             # 승인 범위 내 실행 (provider 중지 상태에서 실행 권장)
```

provider가 실행 중이면 성장 사이클은 7일마다 자동으로 실행됩니다. 보고서는 `data/growth/growth-YYYY-MM-DD.md`에 저장됩니다.
