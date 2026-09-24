# TrendBench 작업 규칙

사람과 AI 모두 이 규칙을 따른다. 제품 맥락은 [PRODUCT.md](docs/PRODUCT.md), 코드와 도메인 문서 위치는 [ARCHITECTURE.md](docs/ARCHITECTURE.md), 실행 방법은 [DEVELOPMENT.md](docs/DEVELOPMENT.md)에 있다.

## 1. 작업 방식

- 시작 전에 `git status`를 본다. 내가 만들지 않은 변경은 덮어쓰거나 숨기지 않는다.
- 사람이 지정한 범위(채팅·Issue) 안에서만 파일을 고친다. 관련 없는 리팩터링·포맷 변경을 섞지 않는다.
- 문서와 코드가 다르면 한쪽을 조용히 따르지 말고 알린다.
- 동시 작업은 branch마다 worktree를 나눈다.
- commit·push·PR은 사람이 요청할 때만 한다.

## 2. 구조

- 앱은 `app/` 하나다: Next.js App Router, TypeScript, PostgreSQL 17, Prisma, Better Auth, Zod.
- 별도 서버·Redis·큐·지도·POS 연동·자동 공고 해석 AI 같은 스택 추가는 [ADR](docs/decisions/README.md)을 먼저 쓴다.
- 웹 요청 중에 외부 데이터를 가져오지 않는다. 공식 데이터는 운영자 적재 명령([DEVELOPMENT.md](docs/DEVELOPMENT.md#로컬-데이터-준비))으로 적재한다.
- 가짜 API, 샘플 운영 데이터, 성공을 흉내 내는 미구현 함수를 만들지 않는다. 기존 계산기·스키마·enum을 재사용한다.

## 3. 데이터·계산 계약

틀리면 사용자가 잘못된 창업 판단을 하는 규칙이다. 바꾸려면 ADR을 먼저 쓴다.

1. 금액은 API·JSON에서 원 단위 정수 문자열이며 계산은 decimal 연산을 사용한다.
2. 누락 `null`, 실제 0, 미확정 `UNKNOWN`을 서로 바꾸지 않는다. 자료 부족이나 외부 장애를 빈 성공 응답 또는 0으로 위장하지 않는다.
3. 상권·임대료·프랜차이즈 관측값을 사용자의 재무 가정에 자동으로 입력하지 않는다.
4. 서울시 상위 업종 관측 범위와 소진공 세부 업종 경쟁 범위를 함께 표시한다. 상위 업종 매출을 세부 업종 매출이나 개인 예상매출로 바꾸지 않는다.
5. 매출의 시간 단위와 점포당 분모가 공식 확정되기 전에는 월 환산·점포당 매출을 [ADR 0002](docs/decisions/0002-provisional-market-sales.md)의 잠정 해석으로만 제공한다. "잠정"과 근거·원값을 함께 표시하고, 계산 결과에 저장하지 않는다.
6. 계획의 소유자는 서버에서 검사한다. 없는 리소스와 타인 소유 리소스는 모두 404다. 계획 변경은 revision을 검사하고 충돌은 409다.
7. 저장된 계산 결과는 append-only다. 과거 결과를 덮어쓰거나 자동 재계산하지 않는다.
8. 미검수·종료·근거 부족 자금 상품을 현재 신청 가능 또는 상환 계산 가능으로 표시하지 않는다.
9. 운영 데이터는 `PENDING → ACTIVE` 검증을 거친다. 새 적재가 실패하면 기존 ACTIVE를 유지한다.
10. 출처 URL, 기준기간, 릴리스 키, checksum, 적용 시점 등 provenance를 보존한다.

## 4. DB·비밀값·위험한 명령

- 적용된 migration은 수정하지 않고 새 migration을 추가한다. schema를 바꾸면 `db:generate`, 앱 DB와 테스트 DB migration, `verify:db`까지 한다.
- `app/prisma/`와 `app/package.json`·`package-lock.json`은 한 번에 한 PR만 고친다.
- 테스트 DB(`TEST_DATABASE_URL`)를 앱 DB와 같게 설정하지 않는다.
- `app/.env.local`, `app/.env.test.local`, `app/.env`, `infra/.env`의 값을 읽거나 출력하지 않는다. API 키와 환경변수 값을 commit·로그·PR에 남기지 않는다.
- 다음은 사람만 실행한다: `prisma migrate reset`, `docker compose down -v`, 운영 원본 삭제, force push, `git reset --hard`, `git clean -f`, `git stash`, 작업 트리 변경을 버리는 `git checkout`·`git restore`.
- `.claude/` hook이 위 명령 일부와 환경파일 읽기를 막는다. hook은 명령 문자열 전체를 검사하므로, PR·Issue 본문에 이런 명령 예시가 있으면 파일로 만들어 `--body-file`로 넘긴다.

## 5. commit·PR

- main은 squash 병합만 한다. PR 제목이 main의 commit 메시지가 된다.
- 제목은 영어 Conventional Commits: `<type>(<scope>): <명령형 요약>`. 예: `feat(plans): compare two saved results`
  - type: `feat` `fix` `refactor` `test` `docs` `style` `ci` `build` `chore`
  - scope: `finance` `plans` `market` `business-directory` `business-profile` `rent-benchmark` `franchise` `funding` `security` `e2e` `db` `deps` `harness`. 여러 영역의 문서만 고치면 생략한다.
- branch: `<type>/<번호>-<영문-slug>`. 예: `feat/12-result-compare`. Issue 없이 하는 작업은 번호를 뺀다. 예: `fix/plan-rate-limits`
- PR 본문은 템플릿(변경 내용·검증·위험)을 채운다. CI `check`가 통과하면 병합한다.
- 문서·주석·화면 문구는 한국어, 식별자·commit 메시지는 영어로 쓴다.

## 6. 검증

저장소 루트에서 실행한다.

| 변경 | 실행 |
|---|---|
| 문서만 | 링크 확인, `git diff --check` |
| 계산·스키마·UI | `npm --prefix app run verify:fast`. UI는 빈 상태·오류·모바일을 직접 확인한다 |
| DB·인증·계획·적재 | `npm --prefix app run verify:db`, 병합 전 `npm --prefix app run verify` |

- 원격 CI는 DB·E2E를 돌리지 않는다. DB를 바꾼 PR에는 로컬 `verify` 결과를 적는다.
- 하네스는 건너뛴 테스트가 있어도 "통과"를 출력한다. Vitest 요약의 `skipped` 수를 확인한다.
- 같은 PC의 worktree들은 테스트 DB와 E2E 포트를 공유한다. `verify:db`·`verify:e2e`·`verify`를 동시에 돌리지 않는다.
- 실행한 검사와 실행하지 못한 검사를 구분해 보고한다.

## 7. 문서

코드와 같은 PR에서 해당 문서 하나를 고친다. 같은 내용을 여러 문서에 복사하지 않는다.

- 도메인 API·적재·계산 정책 → `docs/domains/<도메인>.md`
- 제공 기능·범위 → `docs/PRODUCT.md`
- 폴더·도메인 경계 → `docs/ARCHITECTURE.md`
- 실행·환경·DB·CI → `docs/DEVELOPMENT.md`
- 되돌리기 어려운 결정 → `docs/decisions/`
