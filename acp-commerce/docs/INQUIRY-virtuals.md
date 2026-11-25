# Virtuals 문의문 초안

- 작성일: 2026-11-25
- 수신처(후보): Virtuals Protocol 공식 Discord 개발자 채널, 또는 GitHub `Virtual-Protocol/acp-cli` Issues (공개 게시판)
- 발송 전 확인사항
  - 아래 에이전트 ID와 지갑 주소는 온체인 공개 정보입니다. 다만 공개 게시판(GitHub Issues)에 올릴 때는 노출 여부를 관리자가 결정해 주십시오.
  - 개인 이메일과 소유자 지갑 주소(`0x20f2…`)는 넣지 않았습니다.

---

## 1. 영문 원문 (발송용)

**Title:** ACP v2: `acp browse` returns empty results for all queries; gas sponsorship scope; testnet login loop

Hello Virtuals team,

I'm building a provider agent on ACP v2 using the official `@virtuals-protocol/acp-cli` **1.0.40** (`acp-node-v2` **0.1.15**). I have three questions.

**1. `acp browse` returns `{"data":[]}` for every query (mainnet)**

- Agent: `Tidy Data Desk`, agent ID `01a2148d-e846-72aa-b3ec-c3adbb6d3ea1`, wallet `0x14bf7536eef7f4a46f28aad78bd714f0391f4dee`
- Signer policy: `ACP_ONLY`. Agent auth succeeds, and `acp agent whoami`, `acp offering list` and `acp job list` all work.
- The agent was activated on chains 8453 / 4663 / 5042 after `acp events listen` connected, and it has one public offering ("Data Validation", 0.20 USDC).
- Queries tried: "swap", "trading", "data", "data validation", "data cleaning", "research", "csv", and more. All of them return 0 results, including with `--sort-by successfulJobCount`, `--mode recency|mixed`, `--online all` and `--chain-ids 8453`.
- `acp browse --legacy` fails with Cloudflare **502** ("Failed to get auth challenge").

Is the v2 search index currently empty or under maintenance, or is there an eligibility requirement for the *searching* agent (graduation, ERC-8004 registration, minimum activity, etc.)? Is there a way to confirm that our offering is visible to other agents?

**2. Gas sponsorship scope on Base**

From the SDK source, ACP actions go through `/wallets/alchemy-rpc`, while generic transactions go through `/wallets/alchemy-rpc-erc20`, where gas is paid in an ERC-20 token.

- Are provider-side ACP actions (`setBudget`, `submit`, `sendMessage`) fully gas-sponsored for an agent wallet with a 0 balance?
- Does `acp agent register-erc8004` require the agent to pay gas (in USDC)?
- Is the protocol fee on v2 jobs currently 20% of the job price? Is there a minimum job price?

**3. Testnet login loop**

`IS_TESTNET=true acp configure start` returns a URL on `app-dev.virtuals.io/acp/auth/v2?...`. After signing in, the login popup reappears repeatedly with no error message, so the CLI never receives the token. Mainnet login (`app.virtuals.io`) works with the same account.

Is testnet (Base Sepolia) access restricted, or is there another recommended way to test the end-to-end job flow?

**Additional notes (FYI)**

- With a `deny-all` signer, `acp browse` hangs until the 5-minute approval timeout, even after the approval is granted. Approval results arrive over the wallet SSE stream, which only connects after agent auth, so the agent-auth signature can never resolve.
- On headless Linux, `acp configure complete` saves tokens to the file keyring, but later commands report `Not authenticated` unless `TS_KEYRING_BACKEND=file` is set.
- Node's built-in fetch needs `NODE_USE_ENV_PROXY=1` behind an HTTPS proxy; without it the CLI fails with `fetch failed`.

Thank you!

---

## 2. 국문 번역 (내부 검토용)

**제목:** ACP v2 마켓 검색 결과 0건, 가스비 대납 범위, 테스트넷 로그인 반복 문의

공식 `acp-cli` 1.0.40(`acp-node-v2` 0.1.15)으로 ACP v2 판매자 에이전트를 개발하고 있으며, 아래 3건을 문의드립니다.

**1. 마켓 검색(`acp browse`)이 모든 검색어에서 0건 반환 (메인넷)**

| 항목 | 내용 |
|---|---|
| 에이전트 | Tidy Data Desk (ID `01a2148d-…3ea1`, 지갑 `0x14bf…4dee`) |
| 상태 | 서명키 정책 ACP_ONLY, 인증 정상. 리스너 연결 후 3개 체인 활성화, 공개 상품 1종 |
| 시도한 검색 | swap, trading, data, data validation, data cleaning, research, csv 등 (정렬·모드·온라인·체인 필터 조합 포함) |
| 결과 | 전부 0건. 레거시 검색은 502 오류 |

- **질문:** 검색 색인이 비어 있거나 점검 중인지, 아니면 검색하는 쪽 에이전트에 자격 요건(졸업, ERC-8004 등록 등)이 있는지 문의합니다. 아울러 우리 상품이 다른 에이전트에게 노출되는지 확인하는 방법이 있는지도 문의합니다.

**2. Base 체인의 가스비 대납 범위**

| 질문 | 내용 |
|---|---|
| ① | 잔액 0인 지갑에서 판매자 측 ACP 동작(가격 제시, 납품, 메시지)이 전액 대납되는지 |
| ② | ERC-8004 등록 시 가스비(USDC)를 에이전트가 직접 부담하는지 |
| ③ | v2 프로토콜 수수료가 현재 20%인지, 최소 거래 금액이 있는지 |

**3. 테스트넷 로그인 반복**

- **증상:** app-dev 로그인 후 오류 메시지 없이 로그인 창이 반복해서 뜹니다. 같은 계정으로 메인넷 로그인은 정상입니다.
- **질문:** 테스트넷 접근이 제한되어 있는지, 그 밖에 권장하는 거래 흐름 테스트 방법이 있는지 문의합니다.

**참고 제보 (버그 성격)**

| 증상 | 원인 (SDK 소스 확인) |
|---|---|
| deny-all 서명키 상태에서 검색이 5분 대기 후 실패 | 승인 결과는 지갑 SSE 스트림으로 전달되는데, 이 스트림은 에이전트 인증 후에야 연결됩니다. 그래서 순환 대기가 발생합니다 |
| 헤드리스 Linux에서 로그인 후 "Not authenticated" | 토큰은 파일 키링에 저장되지만, 조회할 때는 다른 저장소 백엔드가 선택됩니다(`TS_KEYRING_BACKEND=file`로 해결) |
| 프록시 환경에서 `fetch failed` | Node 내장 fetch가 HTTPS_PROXY 설정을 따르지 않습니다(`NODE_USE_ENV_PROXY=1`로 해결) |
