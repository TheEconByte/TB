# TrendBench 프로젝트 컨텍스트

이 문서는 현재 구현·운영 데이터·변경 금지 계약의 유일한 원본이다. Claude Code는 `CLAUDE.md`를 통해 세션 시작 시 이 문서를 자동으로 읽는다. 규칙은 [AGENTS.md](../AGENTS.md), 제품 의도는 [PRODUCT.md](PRODUCT.md), 마일스톤은 [TASKS.md](TASKS.md), 작업 절차는 [TEAM_AI_WORKFLOW.md](TEAM_AI_WORKFLOW.md), 실행은 [DEVELOPMENT.md](DEVELOPMENT.md), 도메인 정책은 [domains/](DEVELOPMENT.md#도메인별-구현-계약)를 따른다. 문서와 코드가 다르면 임의로 하나를 선택하지 말고 불일치를 작업 범위에 포함하거나 담당자에게 알린다. 갱신 시점은 Git 이력으로 확인한다.

## 1. 제품 한 문장

TrendBench는 서울에서 음식점·카페 창업을 준비하는 사용자가 공개 상권 관측값과 자신의 재무 가정을 분리해 보고, 초기 필요자금·운영수지·대출 상환 부담·정책자금 검토 후보를 판단하도록 돕는 서비스다.

## 2. 현재 제공하는 기능

| 영역 | 현재 제공 범위 | 기준 |
|---|---|---|
| 사업 조건 입력 | 자치구, 서울시 상위 업종, 소진공 세부 업종, 면적, 층, 상가 유형 | 계획의 `businessProfileJson`에 재무 입력과 분리 저장 |
| 상권 분석 | 상권별 매출 금액·건수, 점포·개폐업, 요일·시간대·성별·연령대 구성 | 서울시 상권분석서비스 상위 업종 관측값 |
| 경쟁 점포 | 자치구·소진공 세부 업종별 점포 수와 최대 50개 목록 | 소진공 상가(상권)정보 ACTIVE 스냅샷 |
| 재무 계획 | 초기 비용, 자기자금, 매출·비용 가정, 부족자금, 운영수지, 손익 기준 | 사용자가 입력한 가정만 계산 |
| 인증·저장 | 회원가입·로그인, 계획 CRUD, revision 충돌, 소유자 권한 | Better Auth + PostgreSQL |
| 계산 결과 | 서버 재계산, 입력·계산 버전과 출처를 보존한 불변 결과 | 기존 결과를 수정하거나 자동 재계산하지 않음 |
| 자금 후보 | 사업 단계·지역·업종·용도에 따른 규칙 기반 후보 분류 | 사람이 검수한 카탈로그만 사용 |
| 대출 가정 적용 | 확정 조건을 갖춘 현재 후보를 사용자가 명시적으로 선택 | 미확정·비대출 상품은 적용 불가 사유 표시 |

공개 상권 화면은 `/markets`, 자금 후보 화면은 `/funding`, 인증된 계획 화면은 `/`이다.

## 3. 현재 제공하지 않는 기능

- 서울시 상위 업종 매출을 소진공 세부 업종 매출이나 개인 예상매출로 변환하지 않는다.
- 매출 원천의 시간 단위가 확정되기 전에는 월 환산과 점포당 매출을 제공하지 않는다.
- 세부 업종 매출·고객·배달 데이터는 재사용 가능한 공식 출처가 없어 제공하지 않는다.
- 임대료와 프랜차이즈 비교는 검수된 운영 스냅샷이 없어 API가 `503 DATASET_UNAVAILABLE`로 실패한다.
- 지도, 주소 자동 상권 매핑, POS 연동, 매출 파일 업로드, ML 예측, 자동 대출 승인, 자동 공고 해석은 범위 밖이다.
- 자금 후보는 승인 결과가 아니며 미검수·종료·근거 부족 상품을 현재 신청 가능으로 표시하지 않는다.

## 4. 현재 데이터 상태

### 서울시 상권

- ACTIVE 릴리스: `seoul-market-2024q1-2025q4-cccae5b95451`
- 기준기간: 2024년 1분기~2025년 4분기
- 영역 1,650건, 매출 원본 172,911행, 점포 원본 611,664행
- 적재 후 분기 지표 24,779건
- 2024년과 2025년 파일의 헤더가 다르므로 연도별 명시적 매핑을 유지한다.
- 결합 키는 표시명이 아니라 `quarter + areaType + areaCode + industryCode`다.

### 소진공 상가(상권)정보

- ACTIVE 릴리스: `semas-seoul-food-20260923-f8bbe2d4bc44`
- 서울 음식점 74,361건, 제품에 매핑된 세부 업종 15개
- 점포명·주소·좌표·업종은 경쟁 현황에만 사용하고 매출로 해석하지 않는다.
- API 키는 `app/.env.local`의 `SEMAS_SERVICE_KEY`에만 두며 Git·로그·문서에 기록하지 않는다.

### 자금 카탈로그

- 현재 실제 카탈로그 5건은 검수자 `UNASSIGNED`와 1차 원문 부족 때문에 운영상 fail-closed 상태다.
- `OPEN/CLOSED/UNKNOWN`은 접수 상태이고 `PASS/FAIL/UNKNOWN`은 자격 판정이므로 합치지 않는다.
- 지원금·보증·대출·공간·프로그램을 서로 다른 지원 유형으로 유지한다.

## 5. 시스템 구조

```text
Browser
  ↓
Next.js App Router + TypeScript (app/)
  ├─ pages and Route Handlers
  ├─ finance / plans / market / business-directory / funding
  └─ Prisma + Better Auth + Zod
  ↓
PostgreSQL 17 (single application database)

Operator commands
  ├─ market:load       verified local public files
  ├─ business:load     approved SEMAS API snapshot
  └─ funding:load      human-reviewed catalog
```

별도 API 서버, Redis, ClickHouse, 메시지 큐는 현재 구조가 아니다. 외부 수집은 웹 요청 중이 아니라 운영자 명령으로만 수행한다.

## 6. 변경하면 안 되는 계약

1. 금액은 API·JSON에서 원 단위 정수 문자열이며 계산은 decimal 연산을 사용한다.
2. 누락 `null`, 실제 0, 미확정 `UNKNOWN`을 서로 바꾸지 않는다.
3. 상권 관측값은 사용자의 재무 가정에 자동 입력하지 않는다.
4. 서울시 상위 업종 관측 범위와 소진공 세부 업종 경쟁 범위를 API와 UI에 함께 표시한다.
5. 매출 원천의 시간 단위와 점포당 분모가 확인되기 전에는 월 환산·점포당 매출을 계산하지 않는다.
6. 계획의 소유자는 서버에서 검사하며 없는 리소스와 타인 소유 리소스는 모두 404다.
7. 계획 변경은 revision을 검사하고 충돌은 409로 응답한다.
8. 저장된 계산 결과는 append-only다. 인접 기능이 과거 결과를 덮어쓰거나 재계산하지 않는다.
9. 미검수·종료·근거 부족 자금 상품을 현재 신청 가능 또는 상환 계산 가능으로 표시하지 않는다.
10. 운영 데이터는 `PENDING → ACTIVE` 검증을 거친다. 새 적재가 실패하면 기존 ACTIVE를 유지한다.
11. 출처 URL, 기준기간, 릴리스 키, checksum, 적용 시점 등 provenance를 보존한다.
12. 테스트 DB와 운영 DB를 같게 설정하지 않는다.
13. 적용된 migration은 수정하지 않고 새 corrective migration을 추가한다.
14. 자료 부족이나 외부 장애를 빈 성공 응답 또는 0으로 위장하지 않는다.

이 목록이 변경 금지 계약의 유일한 원본이다. 다른 문서는 이 절을 링크한다. 항목을 바꾸려면 ADR([decisions/](decisions/README.md))을 먼저 작성한다.

## 7. 코드 지도

| 책임 | 위치 | 구현 계약 |
|---|---|---|
| 페이지·Route Handler | `app/src/app` | 각 도메인 문서 |
| 재무 계산 | `app/src/features/finance` | [domains/finance.md](domains/finance.md) |
| 계획·결과·화면 | `app/src/features/plans` | [domains/plans.md](domains/plans.md) |
| 서울시 상권 | `app/src/features/market` | [domains/market.md](domains/market.md) |
| 소진공 점포 | `app/src/features/business-directory` | [domains/business-directory.md](domains/business-directory.md) |
| 사업 조건 | `app/src/features/business-profile` | [domains/business-profile.md](domains/business-profile.md) |
| 자금 카탈로그·후보 | `app/src/features/funding`, `app/catalog/funding` | [domains/funding.md](domains/funding.md) |
| 인증·DB·공통 API·요청 보안 | `app/src/lib` | [domains/security.md](domains/security.md) |
| DB schema·migration | `app/prisma` | [DEVELOPMENT.md](DEVELOPMENT.md#postgresql) |
| 운영 적재·검증 명령 | `app/scripts` | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 브라우저 흐름 | `app/e2e` | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 로컬 PostgreSQL | `infra` | [DEVELOPMENT.md](DEVELOPMENT.md#postgresql) |
| 공공 원본 재현 검증 | `docs/verification` | [verification/README.md](verification/README.md) |

검증 기준은 [AGENTS.md §8](../AGENTS.md#8-검증), 다음 우선순위는 [TASKS.md](TASKS.md), 작업 요청 양식은 [작업 계약 Issue 템플릿](../.github/ISSUE_TEMPLATE/work-contract.yml)이 원본이다.