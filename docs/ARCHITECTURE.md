# TrendBench 아키텍처 지도

이 문서는 에이전트가 전체 파일을 무작위로 탐색하지 않고 수정 위치와 검증 경로를 찾기 위한 지도다. 실행 구조·저장소 구조·변경 금지 계약은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) §5~§7, 규칙은 [AGENTS.md](../AGENTS.md), 도메인별 구현 계약은 `docs/domains/`, 실행 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 따른다.

이전 POS 애플리케이션은 현재 작업 트리에서 제거했다. 과거 구현이 필요하면 현재 코드에 복사하지 말고 Git 이력에서 목적과 계약을 다시 검토한다.

## 도메인 지도

| 도메인 | 핵심 코드 | API·화면 | 주요 테스트 | 구현 계약 |
|---|---|---|---|---|
| 재무 계산 | `app/src/features/finance` | `/`의 계획 입력·결과 | `finance.test.ts` | [finance.md](domains/finance.md) |
| 계획·불변 결과 | `app/src/features/plans` | `/api/plans`, calculations, results, `/` | `plans.test.ts`, `loan-assumption.test.ts`, `funding-matches.test.ts` | [plans.md](domains/plans.md) |
| 상권 데이터 | `app/src/features/market` | `/markets`, industries, areas, summary, markets/report API | `market.test.ts` | [market.md](domains/market.md) |
| 세부 업종 점포 | `app/src/features/business-directory` | business-categories, businesses/summary API | `business-directory.test.ts` | [business-directory.md](domains/business-directory.md) |
| 사업 조건 | `app/src/features/business-profile` | 계획 business-profile API, 입력 플로우 | `business-profile.test.ts` | [business-profile.md](domains/business-profile.md) |
| 자금 카탈로그·후보 | `app/src/features/funding` | `/funding`, candidates API | `funding.test.ts`, `candidates.test.ts` | [funding.md](domains/funding.md) |
| 인증·요청 보안 | `app/src/lib/auth.ts`, `session.ts`, `request-security.ts`, `rate-limit.ts` | `/api/auth/*`, 업무 API 공통 경계 | `request-security.test.ts`, 계획 API 테스트 | [security.md](domains/security.md) |
| 브라우저 종단 흐름 | `app/e2e/core-flow.spec.ts` | 가입 → 저장·계산 → 재조회 → 소유권 차단 | Playwright desktop/mobile | — |

## 변경 위치 찾기

| 변경하려는 것 | 먼저 볼 위치 | 최소 검증 |
|---|---|---|
| 계산식·반올림·대출 일정 | `features/finance`, [finance.md](domains/finance.md) | `npm --prefix app run test` |
| 계획 API·권한·결과 저장 | `features/plans`, `src/app/api/plans`, Prisma | `npm --prefix app run verify:db` |
| 상권 원본·파싱·공개 지표 | `features/market`, 검증 보고서, manifest | `npm --prefix app run verify:db` |
| 자금 스키마·판정·카탈로그 | `features/funding`, `catalog/funding` | `funding:validate`, `verify:db` |
| 화면 사용자 흐름 | 해당 feature UI와 `app/e2e` | `verify:fast`, `verify:e2e` |
| DB schema·migration | `app/prisma` | migration 적용 후 `verify` |
| 실행·CI·폴더 구조 | `app/scripts`, workflow, 이 문서 | 관련 명령과 문서 링크 검사 |

## 병렬 작업 경계

기능 디렉터리는 읽기·조사 단위이지 자동 쓰기 소유권이 아니다. 실제 수정 경로는 작업 계약 Issue의 "소유 경로"로 예약한다. 서로 다른 feature 내부의 독립 변경은 별도 worktree에서 병렬화할 수 있다. single-writer 영역과 공유 규칙은 [AGENTS.md §2~§3](../AGENTS.md#2-한-작업의-단위)을 따른다.

## 검증 계층

```text
verify:fast  → 카탈로그 + 포맷 + lint + typecheck + DB 비의존 테스트
verify:db    → 전용 PostgreSQL을 사용하는 전체 Vitest
verify:e2e   → production build 기반 desktop/mobile Chromium
verify       → migration 상태부터 DB·브라우저까지 최종 로컬 게이트
verify:ci    → CI의 코드·DB 게이트
```

새 체크아웃은 Docker Desktop을 실행한 뒤 `npm --prefix app run bootstrap`으로 준비한다. 자세한 실패 처리와 데이터 보존 원칙은 [DEVELOPMENT.md](DEVELOPMENT.md)를 따른다.
