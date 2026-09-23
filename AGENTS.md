# TrendBench 작업 규칙

이 파일은 사람과 AI 모두에게 적용되는 저장소 규칙의 유일한 원본이다. 다른 문서는 이 규칙을 복사하지 않고 링크한다.

| 알고 싶은 것 | 원본 |
|---|---|
| 현재 기능·데이터 릴리스·변경 금지 계약 | [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) |
| 작업 계약·worktree·리뷰·병합 절차 | [docs/TEAM_AI_WORKFLOW.md](docs/TEAM_AI_WORKFLOW.md) |
| 도메인별 API·적재·계산 정책 | [docs/domains/README.md](docs/domains/README.md) |
| 전체 문서 지도와 우선순위 | [docs/README.md](docs/README.md) |

## 1. 시작 전에 반드시 할 일

1. `git status --short`, 현재 branch와 HEAD를 확인한다. Claude Code는 세션 시작 hook이 이 정보를 넣어 준다.
2. 기존 변경을 사용자·다른 작업자의 소유로 간주하고 덮어쓰지 않는다.
3. 작업 계약 GitHub Issue에서 목표·비범위·소유 경로·계약 영향·검증 명령을 확인한다. **Issue가 없으면 조사와 제안까지만 하고 파일을 수정하지 않는다.**
4. 수정할 경로가 아래 single-writer 영역이면 같은 영역을 수정하는 열린 Issue·PR이 없는지 확인한다.
5. [PROJECT_CONTEXT.md §6](docs/PROJECT_CONTEXT.md#6-변경하면-안-되는-계약)의 변경 금지 계약을 확인한다.

## 2. 한 작업의 단위

- 한 작업 = 한 GitHub Issue = 한 인간 책임자 = 한 branch = 한 worktree = 한 writer.
- 여러 AI 세션에 같은 working tree를 주지 않는다. 같은 파일을 두 작업이 동시에 수정하지 않는다.
- 관련 없는 리팩터링·이름 변경·포맷 변경을 섞지 않는다. 포맷은 Prettier가 결정한다.
- UI와 API가 같은 계약을 바꾸면 두 작업이 각자 추측하지 않는다. 계약을 바꾸는 작업이 먼저 병합되고 소비하는 작업이 뒤따른다.
- subagent가 이 규칙을 상속한다고 가정하지 않는다. 파일을 수정하는 subagent에는 Issue 번호, 소유 경로, 변경 금지 계약을 명시해 전달한다.

## 3. single-writer 영역

아래 경로는 동시에 한 작업만 수정한다. 영역의 owner는 그 영역을 수정 중인 열린 Issue의 assignee다. 다른 작업이 필요하면 해당 owner에게 작은 선행 PR을 요청하고, 타입 복사나 임시 우회로 병렬성을 만들지 않는다. 이 표를 바꾸면 [작업 계약 Issue 템플릿](.github/ISSUE_TEMPLATE/work-contract.yml)의 체크박스도 같은 이름으로 고친다.

| 영역 | 경로 | 추가 조건 |
|---|---|---|
| DB schema | `app/prisma/schema.prisma`, `app/prisma/migrations/` | 같은 작업이 migration 생성·두 DB 적용·`verify:db`까지 수행 |
| 의존성 | `app/package.json`, `app/package-lock.json` | 의존성 전용 PR. 사람이 lockfile diff와 audit 확인 |
| 공통 계약 | `app/src/features/plans/schema.ts`, `app/src/lib/api.ts` | 소비자 목록과 호환성 테스트 명시 |
| 인증·보안 경계 | `app/src/lib/auth.ts`, `session.ts`, `request-security.ts`, `rate-limit.ts` | 권한·보안 회귀 테스트 필수 |
| 운영 데이터 | `app/src/features/*/loader.ts`, `app/src/features/market/source-files.ts`, `app/scripts/load-*.ts`, `app/catalog/funding/catalog.json` | 원본 checksum·ACTIVE 보존 검증. 카탈로그는 검수자 리뷰 필요 |
| 규칙·컨텍스트 | `AGENTS.md`, `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, `docs/TEAM_AI_WORKFLOW.md`, `docs/TASKS.md` | 문서 owner 한 명이 모아서 반영 |
| 하네스 | `.claude/`, `.github/`, `app/scripts/verify*.ts`, `app/scripts/harness.ts`, 포맷·lint·tsconfig 설정 | 실제 실행 확인 후 병합 |

## 4. 저장소와 아키텍처

- 현재 애플리케이션은 `app/` 하나다. 삭제된 POS 코드를 복원하거나 계약 근거로 사용하지 않는다.
- Next.js App Router + TypeScript + PostgreSQL + Prisma + Better Auth + Zod 구성을 유지한다.
- 별도 서버, Redis, ClickHouse, 메시지 큐, 지도, POS 연동, 자동 공고 해석 AI를 임의로 추가하지 않는다. 스택 변경은 ADR이 먼저다.
- 웹 요청 중 외부 데이터를 수집하지 않는다. 공식 데이터는 운영자 적재 명령으로 스냅샷화한다.
- 가짜 API, 샘플 운영 데이터, 성공을 반환하는 미구현 함수를 만들지 않는다.
- 기존 계산기·검증 스키마·상태 enum을 재사용한다. 충돌을 피하려고 복제하지 않는다.

## 5. 금지 명령과 비밀값

다음은 일반 작업에 포함하지 않는다. Claude Code에서는 `.claude/settings.json`의 hook과 권한 규칙이 실행 전에 거부한다. 필요하면 사람이 직접 실행한다.

- `prisma migrate reset`, `docker compose down -v`, 운영 원본·사용자 파일 삭제
- `git push --force`, `git reset --hard`, `git clean -f`, `git stash`, `git checkout -- <path>`, `git restore <path>`로 기존 변경을 버리거나 숨기기
- `.env.local`, `.env.test.local`, `infra/.env`의 값 읽기·출력·편집. API 키·환경변수 값·로컬 원본을 commit·로그·응답·PR에 노출하기
- commit·push·PR 생성은 작업 계약 Issue의 "AI 권한"이 허용하거나 사람이 명시적으로 요청한 경우에만 한다.

## 6. DB와 데이터

- 적용된 migration을 수정하지 않는다. 새 migration을 추가한다.
- schema 변경 후 `db:generate`, 애플리케이션 DB와 `TEST_DATABASE_URL` DB migration, 실제 DB 대상 확인을 수행한다.
- DB 변경 테스트는 전용 테스트 DB에서만 실행한다. 같은 PC의 여러 worktree는 테스트 DB를 공유하므로 DB·E2E 검증을 동시에 돌리지 않는다.
- 운영 적재는 PENDING 검증 후 ACTIVE로 전환하고 실패 시 기존 ACTIVE를 보존한다.

## 7. branch·commit·PR 형식

main은 squash 병합만 허용한다. **PR 제목이 main에 남는 commit 메시지가 되므로 PR 제목은 반드시 아래 commit 형식을 따른다.** branch 안의 중간 commit도 같은 형식을 권장한다.

- commit·PR 제목: 영어 Conventional Commits. `<type>(<scope>): <명령형 요약>`. 예: `feat(plans): compare two saved results`.
- type:

| type | 용도 |
|---|---|
| `feat` / `fix` | 사용자 기능 추가 / 결함 수정 |
| `refactor` / `test` | 동작 변화 없는 구조 변경 / 테스트만 추가·수정 |
| `docs` | 문서만 변경 |
| `style` | 포맷만 변경 |
| `ci` / `build` | CI workflow / 의존성·빌드 설정 |
| `chore` | 그 밖의 하네스·저장소 관리 |

- scope: 도메인 `finance`, `plans`, `market`, `business-directory`, `business-profile`, `funding`, `security` 또는 공통 `e2e`, `db`(schema·migration), `deps`, `harness`. 여러 영역의 문서만 고치면 scope를 생략한다(`docs: ...`).
- branch: `<type>/<Issue 번호>-<짧은-영문-slug>`. type은 위 목록과 같다. 예: `feat/12-result-compare`.
- PR 본문: 첫 줄 `Closes #<Issue 번호>`, [PR template](.github/PULL_REQUEST_TEMPLATE.md)의 검증 증거를 채운다. 하나의 PR은 하나의 Issue만 닫는다.
- 언어: 문서·주석·화면 문구는 한국어, 식별자·commit 메시지는 영어.

## 8. 검증

저장소 루트에서 실행한다.

```sh
npm --prefix app run verify:fast
npm --prefix app run verify:db
npm --prefix app run verify:e2e
npm --prefix app run verify
```

`verify:fast`는 카탈로그·포맷·lint·typecheck·단위 테스트를 실행한다.

| 변경 종류 | 최소 검사 | 완료 전 권장 검사 |
|---|---|---|
| 문서만 | 링크·명령·현재 상태 대조, `git diff --check` | 관련 담당자 리뷰 |
| 순수 계산·스키마 | 관련 Vitest, `verify:fast` | `verify` |
| UI | `verify:fast`, 실제 빈 상태·오류·모바일 확인 | `verify:e2e`, `verify` |
| 인증·계획·DB | migration을 운영·테스트 DB에 적용, `verify:db` | `verify` |
| 운영 데이터 | 적재기 검증, ACTIVE 보존, 표본 API 확인 | `verify`와 출처 기록 |
| 하네스(.claude·CI·스크립트) | 해당 hook·스크립트 실제 실행 | `verify:fast` |
| 배포 후보 | 해당 없음 | `npm --prefix app run verify` 필수 |

- DB suite가 건너뛴 결과를 완료로 보고하지 않는다. 하네스는 건너뛴 테스트가 있어도 "통과"를 출력하므로 Vitest 요약의 `skipped` 수를 직접 확인한다. `data/raw/` 원본이 없으면 원본 대조 테스트 6개가 건너뛰어진다([DEVELOPMENT.md](docs/DEVELOPMENT.md#로컬-데이터-준비)).
- 이전 commit에서 통과한 검사를 현재 변경의 증거로 재사용하지 않는다.
- 실행한 명령과 결과, 실행하지 못한 검사와 이유를 구분한다.
- 완료 표시 전에 `git diff --check`와 최종 `git status --short`를 확인한다.

## 9. 문서 동기화

같은 사실을 두 문서에 쓰지 않는다. 변경 종류마다 고칠 문서는 하나다.

| 변경 | 고칠 문서 |
|---|---|
| 도메인 API·적재·계산 정책, 도메인 테스트 범위 | `docs/domains/<도메인>.md` |
| 폴더·도메인 경계 | `docs/ARCHITECTURE.md` |
| 실행 명령·환경·DB 운영·CI | `docs/DEVELOPMENT.md` |
| 현재 기능 목록·운영 데이터 릴리스·변경 금지 계약 | `docs/PROJECT_CONTEXT.md` (single-writer) |
| 제품 범위·원칙 | `docs/PRODUCT.md`와 ADR |
| 규칙 / 절차 / 템플릿 | `AGENTS.md` / `docs/TEAM_AI_WORKFLOW.md` / `.github/` (single-writer) |
| 작업 진행 상태 | GitHub Issue. 기능 PR은 `docs/TASKS.md`를 고치지 않는다 |
| 되돌리기 어려운 결정 | `docs/decisions/NNNN-*.md` |

`docs/history/`의 역사 문서는 현재 구현 지침으로 사용하지 않는다. 문서와 코드가 다르면 조용히 한쪽을 따르지 말고 불일치를 보고한다.

## 10. 작업 종료 보고

다음을 빠짐없이 보고한다. 형식은 [TEAM_AI_WORKFLOW.md §5](docs/TEAM_AI_WORKFLOW.md#5-검증과-인수인계)을 따른다.

- 달성한 결과와 남은 범위
- 변경 파일과 계약/API/DB 영향
- 실행한 검증과 결과, 실행하지 못한 검증과 위험
- 데이터 출처·기준일·릴리스
- 남아 있는 기존 변경과 현재 HEAD

코드 생성량이나 AI의 자신감은 완료 증거가 아니다.
