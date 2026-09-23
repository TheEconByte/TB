# TrendBench 개발·검증 환경

## 준비

- Node.js 24 LTS(`.nvmrc`), npm 11(`app/package.json`의 `packageManager`). 다른 npm 주 버전은 lockfile을 다시 써서 충돌을 만든다. 정확한 앱 의존성은 `app/package-lock.json`으로 고정한다.
- DB 작업 시 Docker Compose v2 또는 로컬 PostgreSQL 17.
- Python은 공공파일 검증에만 필요하며 웹앱 실행 조건이 아니다.

모든 명령의 기본 위치는 저장소 루트다. 규칙은 [AGENTS.md](../AGENTS.md), 현재 기능·데이터 계약은 [프로젝트 컨텍스트](PROJECT_CONTEXT.md), 코드 위치는 [아키텍처 지도](ARCHITECTURE.md), 작업 절차는 [팀 AI 개발 공동 지침](TEAM_AI_WORKFLOW.md)을 따른다.

## 포맷·줄바꿈

- 코드 포맷은 Prettier(`app/.prettierrc.json`)가 결정한다. 수동 정렬이나 에이전트별 스타일을 쓰지 않고 `npm --prefix app run format`으로 맞춘다. `verify:fast`·`verify`·CI가 `format:check`를 실행한다.
- 문서(`*.md`), 자금 카탈로그(checksum 대상), 적용된 migration은 Prettier 대상이 아니다(`app/.prettierignore`).
- 줄바꿈은 `.gitattributes`와 `.editorconfig`가 LF로 고정한다. Windows에서 `core.autocrlf` 값과 관계없이 작업 트리도 LF다.
- `app/next-env.d.ts`는 `next dev`와 `next build`가 서로 다르게 다시 쓰는 생성 파일이라 Git에서 추적하지 않는다. `typecheck`가 `next typegen`으로 먼저 만든다.

## 한 PC의 여러 worktree

- `.env.local`, `infra/.env`, 원본 데이터, API 키는 worktree 사이에서 자동 복사하지 않는다. 필요한 값은 사람이 안전하게 준비한다.
- 모든 worktree가 같은 PostgreSQL 컨테이너(`127.0.0.1:5433`)와 같은 테스트 DB(`trendbench_mvp_test`)를 쓴다. `verify:db`·`verify`·`verify:e2e`는 테스트 DB의 ACTIVE 릴리스를 바꾸고 Playwright는 포트 3100을 쓰므로, 같은 PC에서 두 worktree가 동시에 실행하지 않는다. `verify:fast`는 동시에 실행해도 된다.
- 개발 서버를 동시에 띄우면 두 번째부터 `npm --prefix app run dev -- --port <번호>`로 포트를 나눈다.
- schema migration과 운영 적재 명령은 해당 작업 계약의 owner 한 명만 실행한다.

## 앱

```sh
npm --prefix app ci
npm --prefix app run bootstrap
npm --prefix app run dev
```

http://localhost:3000 — 가입·로그인과 인증된 재무계획 초안/불변 결과 화면. 외부 API는 사용하지 않는다.
http://localhost:3000/markets — 로그인 없이 쓰는 공개 상권 탐색 화면. 자치구 → 상권 → 업종 선택과 분기별 표·차트, 출처·기준기간·단위 제한 표시를 제공한다.
http://localhost:3000/funding — 로그인 후 쓰는 자금 후보 화면. 사업단계·자치구·업종·용도 입력과 상태별 후보 그룹, 추가 확인·제외 이유, 상환 계산 가능 여부를 제공한다. 계획 화면(/)에서도 같은 조건을 계획에 저장하고 그 조건으로 후보를 조회하며, 상환 계산이 가능한 대출 후보에 한해 상품 확정 조건을 계획의 대출 가정으로 적용한다.
http://localhost:3000/api/health — 프로세스 생존 상태. DB·인증·외부 API 준비 상태를 보장하는 응답이 아니다.

```sh
npm --prefix app run format
npm --prefix app run format:check
npm --prefix app run lint
npm --prefix app run typecheck
npm --prefix app run test
npm --prefix app run test:db
npm --prefix app run verify:fast
npm --prefix app run verify:db
npm --prefix app run verify:e2e
npm --prefix app run build
npm --prefix app run verify
npm --prefix app run start
```

`start`는 먼저 빌드한 뒤 실행한다. 기본 포트가 사용 중이면 `npm --prefix app run dev -- --port 3001`을 사용한다. 개발 서버와 프로덕션 빌드를 동시에 같은 앱 폴더에서 실행하지 않는다.

Prisma 스키마나 마이그레이션을 바꾼 뒤에는 실행 중인 개발 서버를 재시작한다. 재시작하지 않으면 이전 스키마로 생성된 Prisma 클라이언트가 남아 새 컬럼을 쓰는 요청이 500으로 실패한다.

`bootstrap`은 세 로컬 환경파일이 모두 없을 때만 임의 값을 생성하며 일부만 존재하면 값을 추측하거나 덮어쓰지 않고 실패한다. Compose 기동, 전용 테스트 DB 생성, 운영·테스트 DB migration, Prisma Client와 Playwright Chromium 준비를 멱등하게 수행한다. `-- --skip-browser`로 브라우저 설치만 생략할 수 있다. 운영 데이터는 적재하지 않으므로 [로컬 데이터 준비](#로컬-데이터-준비)를 이어서 따른다.

`test`·`verify:fast`는 DB 비의존 피드백용이다. `test:db`·`verify:db`는 운영 DB와 다른 `TEST_DATABASE_URL`을 강제한다. 최종 `verify`는 Docker Desktop을 직접 시작하거나 재시작하지 않고 migration 상태, 카탈로그, 포맷, lint, typecheck, 전체 Vitest, Playwright를 순서대로 검증한다.

## PostgreSQL

PowerShell:

```powershell
Copy-Item infra/.env.example infra/.env
Copy-Item app/.env.example app/.env.local
```

이미 파일이 있다면 덮어쓰지 말고 필요한 항목만 수정한다. `infra/.env`의 로컬 비밀번호를 설정하고 `app/.env.local`의 DATABASE_URL에도 같은 값을 사용한다. URL의 비밀번호 특수문자는 URL 인코딩한다.

```sh
docker compose --env-file infra/.env -f infra/compose.yaml config --quiet
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait
docker compose --env-file infra/.env -f infra/compose.yaml ps
```

- 새 프로젝트명: `trendbench-mvp`, DB명: `trendbench_mvp`.
- 로컬 접속: `127.0.0.1:5433`, 사용자 `trendbench`.
- 기존 POS용 5432 포트와 데이터 볼륨을 재사용하지 않는다.
- 컨테이너 정지: `docker compose --env-file infra/.env -f infra/compose.yaml stop`.
- `down -v`는 데이터를 삭제하므로 일상 종료 명령으로 쓰지 않는다.

### Docker Desktop 소켓 오류

Docker Desktop 시작 중 `sailor-ingest.sock` 또는 `docker-secrets-engine/engine.sock`을 `.stale`로 바꿀 수 없다는 오류가 나면 애플리케이션이나 PostgreSQL migration 오류가 아니다. 이전 Docker Desktop 백엔드 프로세스나 Windows AF_UNIX 런타임 소켓 상태가 남은 경우다.

1. Docker Desktop 트레이 메뉴에서 종료하고 작업 관리자에서 `Docker Desktop`과 `com.docker.backend`가 종료됐는지 확인한다.
2. 다른 WSL 작업이 없는 경우에만 `wsl.exe --shutdown`을 실행한다. 이 명령은 실행 중인 모든 WSL 배포판을 종료한다.
3. 잠금이 풀린 뒤 `%LOCALAPPDATA%\Docker\run`과 `%LOCALAPPDATA%\docker-secrets-engine`을 삭제하지 말고 타임스탬프가 붙은 `.stale-*` 이름으로 이동한다.
4. Docker Desktop을 다시 한 번 실행하고 `docker info`가 성공한 뒤 `npm --prefix app run verify`를 재실행한다.

이 복구는 런타임 소켓 디렉터리만 대상으로 한다. `infra`의 Compose 볼륨, `docker compose down -v`, Docker Desktop 공장 초기화, `prisma migrate reset`은 이 오류의 일반 복구 절차에 포함하지 않는다.

DB 기동 후 최초 1회 migration과 client 생성을 실행한다. 기존 DB를 초기화하는 `prisma migrate reset`은 사용하지 않는다.

```sh
npm --prefix app run db:validate
npm --prefix app run db:generate
npm --prefix app run db:migrate -- --name <descriptive_name>
npm --prefix app run db:status
```

`prisma.config.ts`가 `app/.env.local`을 먼저 읽고 없으면 `app/.env`를 읽는다. Prisma CLI가 Next.js식 env 파일을 스스로 읽지 않기 때문이며, 그래서 `npm run db:*`와 `npm run market:load`는 앱과 같은 `DATABASE_URL`을 쓴다.

Better Auth 1.7.5는 이메일·비밀번호와 DB 세션을 담당한다. `BETTER_AUTH_SECRET`은 32자 이상의 고엔트로피 값으로 설정하고 저장소에 커밋하지 않는다. 실제 이메일 발송, 비밀번호 복구, 소셜 로그인은 제공하지 않는다.

## 로컬 데이터 준비

`bootstrap`은 schema만 만들고 운영 데이터는 적재하지 않는다. 새 PC의 운영 DB는 비어 있어서 `/markets`의 상권 조회는 `503 RELEASE_UNAVAILABLE`을 반환하고, 세부 업종 목록은 빈 목록과 `nullReason`을 반환한다. 같은 PC에서 기존 Compose 볼륨(`trendbench-mvp`)을 쓰는 clone은 이미 적재된 데이터를 공유한다. 현재 ACTIVE 릴리스는 [PROJECT_CONTEXT.md §4](PROJECT_CONTEXT.md#4-현재-데이터-상태)에서 확인한다.

| 데이터 | 준비 | 적재 |
|---|---|---|
| 서울시 상권 원본 | [verification/README.md](verification/README.md)의 5개 ZIP을 저장소 루트 `data/raw/`(Git 제외)에 둔다. 제공자가 파일을 교체했으면 manifest checksum이 맞지 않으므로, 기존 보유자에게 같은 파일을 받는다 | `npm --prefix app run market:load` |
| 소진공 점포 | 공공데이터포털 인증키를 `app/.env.local`의 `SEMAS_SERVICE_KEY`에 넣는다. 키는 사람이 안전한 채널로 전달하거나 각자 발급한다 | `npm --prefix app run business:load` |
| 자금 카탈로그 | 현재 검수자가 `UNASSIGNED`라 `funding:load`가 적재를 거부한다. `/funding`의 `503 CATALOG_UNAVAILABLE`은 정상적인 fail-closed 상태다 | 검수자 지정 후 `npm --prefix app run funding:load` |

테스트는 운영 데이터가 없어도 전용 테스트 DB에 합성 릴리스를 만들어 실행한다. 다만 `data/raw/`가 없으면 원본 대조 테스트 6개가 건너뛰어지고, 하네스는 그래도 "통과"를 출력한다. 전체 검증 결과를 보고할 때는 Vitest 요약 줄(`Tests ... passed`)에 `skipped`가 없는지 확인한다.

## CI

현재 `.github/workflows/check.yml`은 `.nvmrc`의 Node에서 PR diff의 공백 오류(`git diff --check`), `npm ci`, 포맷 검사, lint, typecheck, DB 비의존 unit test, production build만 실행한다. PostgreSQL service, migration, DB suite, Playwright, artifact 보존은 아직 원격 CI에 연결되지 않았다. 따라서 GitHub의 초록색 check만으로 DB·브라우저 검증까지 통과했다고 말할 수 없다.

DB·E2E 변경 PR은 작성자가 로컬 `npm --prefix app run verify` 결과를 PR에 기록한다. 원격 CI를 확장하기 전에는 이 제한을 branch ruleset과 PR template에서 명시한다. CI 변경은 자체 검증 없이 문서만 먼저 “구현됨”으로 바꾸지 않는다.

## 도메인별 구현 계약

API·적재·계산 정책과 도메인 테스트 범위는 [domains/README.md](domains/README.md)의 도메인 문서가 원본이다.

## 데이터 검증

[검증 도구 안내](verification/README.md)를 따른다. 원본 ZIP은 저장소에 포함하지 않는다. 지난 검증 보고서의 다운로드 시점과 지금의 최신 제공 시점을 구분한다.
