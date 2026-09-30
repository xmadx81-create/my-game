# 퇴근까지 버텨라! – 분노 게이지 시뮬레이터

> 오늘도 무사히 퇴근할 수 있을까?
> 분노 게이지 100%가 되면 당신의 멘탈이 먼저 퇴근합니다.

서비스업 직원이 출근부터 퇴근까지 손님과 돌발 사건을 버티는 블랙코미디 생존 시뮬레이션입니다.
`index.html` 한 파일로 동작하며 서버·DB·외부 라이브러리가 필요 없습니다. (웹폰트만 Google Fonts에서 불러오고, 오프라인이면 시스템 글꼴로 대체됩니다.)

## 실행 방법

| 방법 | 절차 |
|---|---|
| 로컬 | `anger-simulator/index.html` 파일을 브라우저로 열기 |
| GitHub Pages | 저장소 Pages 배포 경로 뒤에 `/anger-simulator/` 추가 (Pages 설정 확인 필요) |

## 조작 방법

| 입력 | 동작 |
|---|---|
| 직업·난이도 선택 → `출근하기` | 하루 근무 시작 |
| A~D 버튼 또는 키보드 `1`~`4` | 대응 선택 |
| `Space` | 일시정지 / 계속 |
| `Enter` | 결과 화면에서 다음 손님 |
| 상단 `×1 ×2 ×5 ×10 ×20` | 시뮬레이션 속도 (기본 ×10 ≈ 9시간 근무를 약 9분에 진행) |
| 우측 `근무 설정` | 직업·난이도·근무시간·손님 빈도·진상 확률·각종 ON/OFF |
| 우측 `DEV TEST PANEL` | 손님 즉시 호출, 분노 ±10, 퇴근 1분 전 이동, 게임오버/퇴근 성공 테스트 |

## 게임 규칙 요약

- 능력치: 분노(0~100) · 멘탈(0~100) · 체력(0~100) · 친절(0~100) · 고객 평판(0~5) · 카페인(0~5)
- 게임오버: 분노 100% / 멘탈 0 / 평판 0
- 진상 콤보: 진상 계열 손님이 연속으로 오면 COMBO, ×5부터 HELL MODE(분노 증가량 ×1.5)
- 마감 10분 전: 진상·환불·단체손님 확률 증가, 퇴근 1분 전 슬로모션 + “마지막 1분 손님”(퇴근 +15분, 분노 +30) 가능
- 기록·설정·업적·칭호는 브라우저 `localStorage`(`anger-sim-v1` 키)에 저장

## 콘텐츠 규모

| 구분 | 수량 |
|---|---|
| 손님 유형 | 18종 (희귀 5종 포함) |
| 상황(시나리오) | 95개 (손님 공통 + 직업 8종 전용 + 돌발 사건) |
| 돌발 사건 | 18종 |
| 아이템 | 6종 |
| 업적 / 칭호 | 16개 / 12개 |

## 코드 구조 (index.html 내부 `<script>`)

| 영역 | 내용 |
|---|---|
| 데이터 | `CUSTOMERS` `JOB_TYPES` `EVENTS` `ITEMS` `CHOICES` `DIFFICULTIES` `FREQUENCIES` `RANDOM_MESSAGES` `NPC_DIALOGUES` `ACHIEVEMENTS` `TITLES` `BALANCE` |
| 엔진 | `initGame` `startGame` `pauseGame` `resetGame` `spawnCustomer` `spawnEvent` `showScenario` `selectChoice` `updateAnger` `useItem` `checkGameOver` `checkWorkComplete` `showResult` `unlockAchievement` `saveGameData` `loadGameData` |
| 화면 | `updateClock` `updateStats` `renderScene` `renderCustomerLog` `renderStatistics` `renderTray` `renderSettings` |

## 새 손님·상황 추가 방법

코드 수정 없이 데이터 배열에 객체만 추가하면 됩니다.

```js
// CUSTOMERS 배열에 추가
{
  id: 'umbrella', name: '우산 빌려달라는 손님', icon: '☂️', type: 'customer', jinsang: true,
  angerMin: 6, angerMax: 14, probability: 5,
  scenarios: [
    { id: 'umb_borrow', lines: [['c', '우산 하나만 빌려줘요. 내일 갖다줄게요.'], ['n', '지난달 빌려간 우산 12개는 돌아오지 않았다.']],
      choices: [
        { text: '“판매용 우산은 있습니다.”', style: 'std', fx: { anger: 4, rep: 0.2 }, result: '손님이 3천 원짜리 우산을 샀다.' },
        { text: '“우산은 제 마음속에만 있어요.”', style: 'humor', fx: { anger: -6, rep: -0.1 }, result: '손님이 웃으며 비를 맞고 뛰어갔다.' },
        innerChoice('우산 12개의 행방을 아시는 분…'),
      ] },
  ],
},
```

- `lines` 화자: `c` 손님 · `s` 나 · `n` 상황 설명
- `style`: `std` 정석형 · `dodge` 회피형 · `humor` 유머형 · `risk` 위험형 · `inner` 속마음
- `fx`: `anger` `mental` `stamina` `kind` `rep` `caffeine` `overtime`(분)
- 직업 전용 상황은 `JOB_TYPES[].scenarios`에 `customer: '손님 id'`를 붙여 추가
