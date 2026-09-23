# TrendBench 작업 규칙

사람과 AI 모두에게 적용되는 저장소 규칙은 이 파일 하나에 둔다. Claude Code는 `CLAUDE.md`를 통해 세션 시작 시 이 파일을 읽는다. 협업 절차는 [CONTRIBUTING.md](CONTRIBUTING.md), 실행 방법은 [DEVELOPMENT.md](docs/DEVELOPMENT.md), 도메인별 API·적재·계산 정책은 [ARCHITECTURE.md](docs/ARCHITECTURE.md)의 도메인 지도에서 찾는다.

## 1. 작업 시작

- `git status`로 기존 변경을 확인한다. 내가 만들지 않은 변경은 다른 사람의 것으로 보고 덮어쓰거나 숨기지 않는다.
- 파일 수정은 GitHub Issue나 사람이 채팅에서 지정한 범위 안에서만 한다. 범위가 불분명하면 조사와 제안까지만 한다.
- 관련 없는 리팩터링·이름 변경·포맷 변경을 섞지 않는다. 포맷은 Prettier가 결정한다.
- 문서와 코드가 다르면 조용히 한쪽을 따르지 말고 불일치를 알린다.
- 파일을 수정하는 subagent에는 작업 범위와 §3 계약을 명시해 전달한다.

## 2. 구조와 스택

- 애플리케이션은 `app/` 하나다. Next.js App Router + TypeScript + PostgreSQL 17 + Prisma + Better Auth + Zod를 유지한다.
- 별도 서버, Redis, 메시지 큐, 지도, POS 연동, 자동 공고 해석 AI 같은 스택 추가는 [ADR](docs/decisions/README.md)이 먼저다.
- 웹 요청 중 외부 데이터를 수집하지 않는다. 공식 데이터는 운영자 적재 명령(`market:load`, `business:load`, `funding:load`)으로 스냅샷화한다.
- 가짜 API, 샘플 운영 데이터, 성공을 반환하는 미구현 함수를 만들지 않는다.
- 기존 계산기·검증 스키마·상태 enum을 재사용한다. 충돌을 피하려고 복제하지 않는다.

## 3. 데이터·계산 계약

이 프로젝트에서 가장 틀리기 쉽고, 틀리면 사용자가 잘못된 창업 판단을 하는 규칙이다. 바꾸려면 ADR이 먼저다.

1. 금액은 API·JSON에서 원 단위 정수 문자열이며 계산은 decimal 연산을 사용한다.
2. 누락 `null`, 실제 0, 미확정 `UNKNOWN`을 서로 바꾸지 않는다. 자료 부족이나 외부 장애를 빈 성공 응답 또는 0으로 위장하지 않는다.
3. 상권 관측값은 사용자의 재무 가정에 자동 입력하지 않는다.
4. 서울시 상위 업종 관측 범위와 소진공 세부 업종 경쟁 범위를 API와 UI에 함께 표시한다. 상위 업종 매출을 세부 업종 매출이나 개인 예상매출로 바꾸지 않는다.
5. 매출 원천의 시간 단위와 점포당 분모가 확인되기 전에는 월 환산·점포당 매출을 계산하지 않는다.
6. 계획의 소유자는 서버에서 검사하며 없는 리소스와 타인 소유 리소스는 모두 404다. 계획 변경은 revision을 검사하고 충돌은 409다.
7. 저장된 계산 결과는 append-only다. 과거 결과를 덮어쓰거나 자동 재계산하지 않는다.
8. 미검수·종료·근거 부족 자금 상품을 현재 신청 가능 또는 상환 계산 가능으로 표시하지 않는다.
9. 운영 데이터는 `PENDING → ACTIVE` 검증을 거친다. 새 적재가 실패하면 기존 ACTIVE를 유지한다.
10. 출처 URL, 기준기간, 릴리스 키, checksum, 적용 시점 등 provenance를 보존한다.

## 4. DB·비밀값·금지 명령

- 적용된 migration은 수정하지 않고 새 migration을 추가한다. schema를 바꾸면 `db:generate`, 앱 DB와 테스트 DB migration, `verify:db`까지 같은 작업에서 한다.
- 테스트 DB(`TEST_DATABASE_URL`)를 앱 DB와 같게 설정하지 않는다. DB를 바꾸는 테스트는 테스트 DB에서만 실행한다.
- `.env.local`, `.env.test.local`, `infra/.env`의 값을 읽거나 출력하지 않는다. API 키·환경변수 값·로컬 원본을 commit·로그·PR에 남기지 않는다.
- 다음은 사람이 직접 판단해 실행한다: `prisma migrate reset`, `docker compose down -v`, 운영 원본·사용자 파일 삭제, force push, `git reset --hard`, `git clean -f`, `git stash`, `git checkout -- <path>`·`git restore <path>`로 변경 버리기.
- Claude Code의 hook이 위 명령 일부와 환경파일 읽기를 실행 전에 막는다. 전부 막지는 못하므로 hook을 통과했다고 안전한 명령은 아니다.
- commit·push·PR 생성은 사람이 요청했을 때만 한다.

## 5. 공유 파일

아래 파일은 동시에 열린 PR 하나만 수정한다. 시작 전에 팀에 알린다.

- `app/prisma/schema.prisma`, `app/prisma/migrations/`
- `app/package.json`, `app/package-lock.json`: 의존성만 바꾸는 PR로 분리하고 lockfile diff와 `npm audit`을 사람이 확인한다.
- `app/catalog/funding/catalog.json`: 검수자 리뷰가 필요하다.

## 6. commit·branch·PR

main은 squash 병합만 허용하므로 **PR 제목이 main의 commit 메시지가 된다.**

- 제목: 영어 Conventional Commits `<type>(<scope>): <명령형 요약>`. 예: `feat(plans): compare two saved results`
- type: `feat` `fix` `refactor` `test` `docs` `style` `ci` `build` `chore`
- scope: `finance` `plans` `market` `business-directory` `business-profile` `funding` `security` `e2e` `db` `deps` `harness`. 여러 영역의 문서만 고치면 생략한다(`docs: ...`).
- branch: `<type>/<Issue 번호>-<짧은-영문-slug>`. 예: `feat/12-result-compare`
- 언어: 문서·주석·화면 문구는 한국어, 식별자·commit 메시지는 영어.

## 7. 검증

저장소 루트에서 실행한다.

| 변경 | 최소 | 병합 전 추가 |
|---|---|---|
| 문서만 | 링크 확인, `git diff --check` | — |
| 계산·스키마·UI | `npm --prefix app run verify:fast` | UI는 빈 상태·오류·모바일을 직접 확인. `/` 흐름을 바꾸면 `verify:e2e` |
| DB·인증·계획·적재 | `npm --prefix app run verify:db` | `npm --prefix app run verify` |

- `verify:fast`는 카탈로그·포맷·lint·typecheck·DB 비의존 테스트를, `verify`는 migration 상태부터 DB 테스트와 Playwright까지 실행한다. 원격 CI는 DB·E2E를 돌리지 않으므로 DB 변경 PR에는 로컬 `verify` 결과를 적는다.
- 하네스는 건너뛴 테스트가 있어도 "통과"를 출력한다. `verify:db`·`verify` 결과는 Vitest 요약의 `skipped` 수까지 확인한다([로컬 데이터 준비](docs/DEVELOPMENT.md#로컬-데이터-준비)).
- 같은 PC의 worktree들은 테스트 DB와 E2E 포트 3100을 공유한다. `verify:db`·`verify:e2e`·`verify`를 동시에 돌리지 않는다.
- 실행한 검사와 결과, 실행하지 못한 검사와 이유를 구분해 PR 템플릿에 적는다. 이전 commit의 결과를 현재 변경의 증거로 쓰지 않는다.

## 8. 문서

코드와 같은 PR에서 해당 문서를 고친다. 같은 내용을 여러 문서에 복사하지 않고 링크한다.

| 바뀐 것 | 고칠 문서 |
|---|---|
| 도메인 API·적재·계산 정책, 적재한 기준 데이터 | `docs/domains/<도메인>.md` |
| 사용자에게 제공하는 기능·범위 | `docs/PRODUCT.md` |
| 폴더·도메인 경계 | `docs/ARCHITECTURE.md` |
| 실행 명령·환경·DB 운영·CI | `docs/DEVELOPMENT.md` |
| 규칙 / 협업 절차 | `AGENTS.md` / `CONTRIBUTING.md` |
| 되돌리기 어려운 결정 | `docs/decisions/NNNN-*.md` |

작업 진행 상태는 GitHub Issue와 Milestone에서만 관리한다. `docs/history/`는 과거 기록이며 현재 지침이 아니다.
