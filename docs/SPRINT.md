# 데모 스프린트 (~2026-09-28)

2026-09-28 로컬 노트북 데모까지 쓰는 임시 문서다. 데모가 끝나면 삭제한다. 범위와 잠정 매출 해석의 근거는 [ADR 0002](decisions/0002-demo-sprint-scope.md)에 있다. `CLAUDE.md`가 이 문서를 매 세션 자동으로 읽는다.

## 데모 시나리오 (완성 기준)

"성수동 카페 창업 준비생 A씨"

1. `/markets`: 성동구 → 성수1가1동 → 커피·음료. 매출·점포·개폐업·구성과 상권 단위 경쟁 점포를 보고 [이 상권으로 계획 시작]을 누른다.
2. 로그인하면 상권·업종이 채워진 계획이 만들어진다. 매출 가정은 도우미(고객 수 × 객단가 × 영업일)로 세운다. 옆에 관측 참고값(잠정 점포당 월매출, 결제 1건당 평균 금액)이 표시된다. 자동으로 입력하지는 않는다.
3. 결과: 부족자금·운영수지·상환 일정·3개 시나리오와 함께 손익분기 매출을 상권 점포당 월매출(잠정)과 비교한다.
4. 자금 후보: 검수된 카탈로그로 분류와 이유를 본다. 적용 가능한 대출이 있으면 적용하고 다시 계산한다.
5. 가정을 바꿔 저장한 결과 2개를 비교한다. 저장하지 않고 떠나면 경고한다.
6. 모든 화면이 사용자 언어이고, 키보드·모바일로도 동작한다.

## 스프린트 규칙

- **작업 범위:** 아래 WP 번호가 작업 범위다. 사람이 채팅에서 "WP2"처럼 지정하면 그 WP의 파일 안에서만 고친다. Issue를 따로 만들지 않아도 된다.
- **branch:** `<type>/wp<번호>-<slug>`. 예: `feat/wp2-provisional-sales`. PR 제목은 [AGENTS.md §6](../AGENTS.md#6-commitbranchpr) 형식을 따른다.
- **병합 순서:**
  - `TrendBenchApp.tsx`와 `MarketExplorer.tsx`는 WP1이 먼저 바꾼다.
  - WP2·WP3·WP4는 새 컴포넌트 파일에서 만들고, 두 파일에는 WP1 병합 뒤 몇 줄만 삽입한다.
  - 다른 PR이 병합되면 바로 rebase한다.
- **migration:** 스프린트 동안 WP5 하나만 만든다.
- **PR:** 작게 만들어 하루 2번 이상 main에 합친다. CI `check`가 통과하면 바로 병합한다.
- **main 보호 규칙:** 스프린트 동안 ruleset `main protection`을 비활성화했다. 승인 없이 병합할 수 있다. 데모가 끝나면 다시 켠다([CONTRIBUTING.md](../CONTRIBUTING.md#github-설정)의 설정으로).
- **문서:** 각 WP가 자기 도메인 문서와 [PRODUCT.md](PRODUCT.md)의 현재 기능 한 줄을 함께 고친다.
- **데모 노트북:** 데이터가 이미 적재된 작성자 PC다.

## 작업 패키지

| WP | 내용 | 주요 파일 | 담당 |
|---|---|---|---|
| WP1 | 상권 → 계획 연결: `/markets` CTA, 사업 조건에 `marketArea`, 마법사에 상권 선택, `MarketObservationPanel`을 분리해 계획 화면에 표시 | `business-profile/*`, `market/MarketObservationPanel.tsx`(새), `MarketExplorer.tsx`, `plans/TrendBenchApp.tsx` | |
| WP2 | 잠정 월 지표(report API `provisional`)와 손익분기 비교 카드 | `market/read.ts`·`types.ts`, `plans/BreakEvenComparison.tsx`(새), `docs/domains/market.md` | |
| WP3 | 매출 가정 도우미. [적용]을 눌러야 월매출에 들어가고, 관측 1건당 금액은 참고로만 표시 | `finance/revenue-helper.ts`(새), `FinancePlanner.tsx`, `docs/domains/finance.md` | |
| WP4 | 결과 2개 비교, 저장하지 않은 변경 이탈 경고(#6) | `plans/ResultComparison.tsx`(새), `TrendBenchApp.tsx` | |
| WP5 | 상권 단위 경쟁 점포(#4): SHP 파서, WGS84→EPSG:5181 변환(의존성 없이), point-in-polygon, `business:assign-areas`, 배정 테이블 migration, summary `areaCode` | `market/shp.ts`·`geo.ts`(새), `prisma/`, `scripts/assign-business-areas.ts`, business-directory | |
| WP6 | 자금 카탈로그: 팀원 검수자 지정, 기존 5건 재확인, 접수 중 상품 추가, version 올리고 적재(#13) | `app/catalog/funding/*`, `docs/domains/funding.md` | |
| WP7 | 화면 문구 정리: 개발자용 문구 제거, 출처는 "출처 보기"로 접기. Day 4 오전에 한 번에 | `features/**/*.tsx` | |
| WP8 | 데모 준비: `e2e/demo-flow.spec.ts`, 키보드·모바일 E2E(#7), 데모 계정, 리허설 2회, 녹화 | `app/e2e/*` | |
| WP9 | 원격 CI에 PostgreSQL·DB 테스트·E2E 추가(#11) | `.github/workflows/check.yml` | Claude |
| WP10 | 같은 PC의 worktree 병렬 세션: main worktree의 환경파일을 이어받고 테스트 DB 이름·E2E 포트만 분리(#1) | `scripts/bootstrap.ts`, `playwright.config.ts`, `docs/DEVELOPMENT.md` | Claude |

- #3·#12는 서울시에 공식 문의만 보낸다. 답이 오면 ADR 0002를 대체한다.

## 인터페이스 계약

병렬 작업이 서로를 기다리지 않도록, 아래 형태를 먼저 맞추고 각자 구현한다.

- **사업 조건 `marketArea`(WP1):** `{ areaType: string; areaCode: string } | null` 선택 필드.
  - 저장할 때 활성 상권 릴리스로 검증하고 `areaName`과 `provenance.marketReleaseKey`를 함께 저장한다(`business-profile/resolve.ts` 패턴).
  - 이 필드가 없는 기존 계획은 그대로 유효하다. `businessProfileJson`만 바뀌므로 migration은 없다.
- **`MarketObservationPanel` props(WP1):** `{ areaType: string; areaCode: string; industryCode: string; compact?: boolean }`. `/api/markets/report` 결과를 그린다.
- **`/markets` CTA(WP1):** `/?areaType=…&areaCode=…&industryCode=…`. 로그인 전이면 로그인한 뒤 이어받는다.
- **report 응답 `provisional`(WP2):**

  ```ts
  provisional: {
    basis: 'SEOUL_GUIDE_QUARTER_MONTHLY_AVG';
    label: '잠정';
    sourceUrl: string;
    quarters: Array<{
      quarter: string;
      monthlySalesAmount: string | null;         // 원값(분기 월평균 해석)
      perStoreMonthlySalesAmount: string | null; // 원값 ÷ similarIndustryStoreCount
      averageTicketAmount: string | null;        // 원값 ÷ salesCount
    }>;
  }
  ```

  금액은 원 단위 정수 문자열로 `ROUND_HALF_UP` 반올림한다. 분모가 없거나 0이면 `null`이다. 검산 표본: 성수1가1동 커피·음료 2025년 4분기 → 점포당 16,747,231원.
- **`BreakEvenComparison` props(WP2):** `{ operatingBreakEvenRevenue, debtInclusiveBreakEvenRevenue, provisional }`. 재무 결과 값과 최근 분기, 8개 분기 범위를 비교한다. 잠정 값은 `plan_results`에 저장하지 않는다.
- **매출 도우미(WP3):** `estimateMonthlyRevenue({ dailyCustomers, averageTicket, operatingDays }): string | null`. 객단가 참고는 `provisional.quarters`의 최근 분기 `averageTicketAmount`를 쓴다.
- **경쟁 점포 summary(WP5):** `?areaCode=`가 있으면 상권 기준, 없거나 배정 전이면 자치구 기준이다. 응답의 `scope: 'AREA' | 'DISTRICT'`로 화면에 기준을 표시한다.

## 일정

| 날 | 할 일 |
|---|---|
| Day 0 (9/23) | 이 문서가 담긴 PR #9 병합. 팀원 온보딩([DEVELOPMENT.md](DEVELOPMENT.md): `bootstrap`, `data/raw` 원본 공유, 소진공 키). WP1·2·3·5·6·10 착수 |
| Day 1 | WP1 병합(오전). WP2 API 병합. WP9 병합 |
| Day 2 | WP2 UI, WP3, WP4. WP5 migration·배정 명령 병합. WP6 적재 |
| Day 3 | WP5 화면 반영. WP8 E2E. 통합 테스트와 버그 수정 |
| Day 4 | 오전 WP7 → 정오 기능 동결 → 데모 노트북에서 `verify` 전체 통과 → 리허설 2회, 녹화 |
| Day 5 (9/28) | 데모 |
