# TrendBench 아키텍처 지도

수정 위치와 도메인 문서를 찾기 위한 지도다. 규칙은 [AGENTS.md](../AGENTS.md), 실행 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 따른다.

## 시스템 구조

```text
Browser
  ↓
Next.js App Router + TypeScript (app/)
  ├─ pages and Route Handlers
  ├─ finance / plans / market / business-directory / business-profile / rent-benchmark / franchise / funding
  └─ Prisma + Better Auth + Zod
  ↓
PostgreSQL 17 (single application database)

Operator commands
  ├─ market:load       Seoul Open API (or verified files)
  ├─ business:load     SEMAS API snapshot
  ├─ rent:load         REB R-ONE rent survey
  ├─ franchise:load    FTC franchise disclosure stats
  └─ funding:load      human-reviewed catalog
```

외부 수집은 웹 요청 중이 아니라 운영자 명령으로만 수행한다.

## 도메인 지도

도메인을 바꾸는 PR은 코드·테스트와 함께 해당 도메인 문서를 고친다. 새 도메인을 추가하면 이 표에 한 줄을 더한다.

| 도메인 | 코드 | API·화면 | 주요 테스트 | 정책 문서 |
|---|---|---|---|---|
| 재무 계산 | `app/src/features/finance` | `/`의 계획 입력·결과 | `finance.test.ts` | [finance.md](domains/finance.md) |
| 계획·불변 결과 | `app/src/features/plans` | `/api/plans/**`, `/` | `plans.test.ts`, `loan-assumption.test.ts`, `funding-matches.test.ts` | [plans.md](domains/plans.md) |
| 서울시 상권 | `app/src/features/market` | `/markets`, industries·areas·summary·report API | `market.test.ts` | [market.md](domains/market.md) |
| 소진공 점포 | `app/src/features/business-directory` | business-categories·businesses/summary API | `business-directory.test.ts` | [business-directory.md](domains/business-directory.md) |
| 임대료 참고 | `app/src/features/rent-benchmark` | rent-benchmarks API, `/`의 임대료 참고 패널 | `rent-benchmark.test.ts`, `rent-benchmark.spec.ts` | [rent-benchmark.md](domains/rent-benchmark.md) |
| 프랜차이즈 참고 | `app/src/features/franchise` | franchises API, `/`의 프랜차이즈 참고 패널 | `franchise.test.ts`, `franchise.spec.ts` | [franchise.md](domains/franchise.md) |
| 사업 조건 | `app/src/features/business-profile` | 계획 business-profile API, 입력 플로우 | `business-profile.test.ts` | [business-profile.md](domains/business-profile.md) |
| 자금 카탈로그·후보 | `app/src/features/funding`, `app/catalog/funding` | `/funding`, candidates API | `funding.test.ts`, `candidates.test.ts` | [funding.md](domains/funding.md) |
| 인증·요청 보안 | `app/src/lib/auth.ts`, `session.ts`, `request-security.ts`, `rate-limit.ts` | `/api/auth/*`, 업무 API 공통 경계 | `request-security.test.ts`, 계획 API 테스트 | [security.md](domains/security.md) |

## 그 밖의 위치

| 책임 | 위치 |
|---|---|
| 페이지·Route Handler | `app/src/app` |
| DB schema·migration | `app/prisma` |
| 운영 적재·검증·하네스 명령 | `app/scripts` |
| 브라우저 종단 흐름 (`/` 가입 → 저장·계산 → 재조회 → 소유권 차단) | `app/e2e/core-flow.spec.ts` |
| 로컬 PostgreSQL | `infra` |
| 공공 원본 재현 검증 | [docs/verification](verification/README.md) |
