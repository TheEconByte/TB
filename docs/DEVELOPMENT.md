# 개발 환경

모든 명령은 저장소 루트에서 실행한다.

## 준비

- Node.js 24(`.nvmrc`), npm 11(`packageManager`). 다른 npm 주 버전은 lockfile을 다시 써서 충돌을 만든다.
- Docker Desktop(PostgreSQL 17 컨테이너). Windows에서는 Claude Code hook 실행에 Git for Windows가 필요하다.
- Python은 공공 원본 검증 도구([verification/](verification/README.md))에만 필요하다.

```sh
npm --prefix app ci
npm --prefix app run bootstrap
npm --prefix app run dev
```

`bootstrap`이 하는 일:
- 환경파일 3개가 모두 없으면 임의 값으로 만든다. 일부만 있으면 추측하지 않고 실패한다.
- PostgreSQL을 띄우고, 테스트 DB를 만들고, 앱·테스트 DB에 migration을 적용한다.
- Prisma Client와 Playwright Chromium을 준비한다.
- 운영 데이터는 적재하지 않는다.
- 브라우저 설치를 건너뛰려면 `npm --prefix app run bootstrap -- --skip-browser`를 쓴다. 이미 설치했고 migration만 적용할 때 쓴다.

## 환경파일

| 파일 | 값 |
|---|---|
| `infra/.env` | `POSTGRES_PASSWORD`, `POSTGRES_PORT` |
| `app/.env.local` | `DATABASE_URL`, `BETTER_AUTH_SECRET`(32자 이상), `BETTER_AUTH_URL`, 상권 적재 시 `SEOUL_OPEN_API_KEY`, 점포·프랜차이즈 적재 시 `SEMAS_SERVICE_KEY`, 임대료 적재 시 `REB_API_KEY` |
| `app/.env.test.local` | `TEST_DATABASE_URL`(DB명 `trendbench_mvp_test`) |

직접 만들 때는 세 파일을 모두 만든다. 비밀번호는 같은 값을 쓰고 URL의 특수문자는 인코딩한다. 예시는 `infra/.env.example`과 `app/.env.example`에 있다. Prisma CLI와 적재 명령도 `app/.env.local`을 읽는다.

## 로컬 데이터 준비

새 DB는 비어 있다. 적재 전에는 상권 조회가 `503 RELEASE_UNAVAILABLE`, 자금 후보 조회가 `503 CATALOG_UNAVAILABLE`, 경쟁 점포 조회가 `503 BUSINESS_DIRECTORY_UNAVAILABLE`(세부 업종 목록은 200과 빈 목록), 임대료·프랜차이즈 조회가 `503 DATASET_UNAVAILABLE`로 응답한다.

| 데이터 | 준비 | 적재 |
|---|---|---|
| 서울시 상권 | 서울 열린데이터광장 인증키를 `SEOUL_OPEN_API_KEY`에 넣는다. 약 2분 걸린다 | `npm --prefix app run market:load` |
| 소진공 점포 | 공공데이터포털에서 [상가(상권)정보](https://www.data.go.kr/data/15012005/openapi.do)를 활용신청하고, 인증키(Decoding)를 `SEMAS_SERVICE_KEY`에 넣는다 | `npm --prefix app run business:load` |
| 부동산원 임대료 | 부동산통계정보시스템(R-ONE) Open API 인증키를 `REB_API_KEY`에 넣는다. 약 30초 걸린다 | `npm --prefix app run rent:load` |
| 공정위 프랜차이즈 | `SEMAS_SERVICE_KEY`(공공데이터포털 인증키)로 [가맹점 현황](https://www.data.go.kr/data/15110241/openapi.do)·[창업 금액](https://www.data.go.kr/data/15110265/openapi.do)을 활용신청한다 | `npm --prefix app run franchise:load` |
| 자금 카탈로그 | 준비 없음. 검수자가 UNASSIGNED여도 적재되며, 그런 상품은 현재 후보가 아니라 추가 확인으로 분류된다 | `npm --prefix app run funding:load` |

2026-09-09 검증본 ZIP으로 적재하려면 [verification/README.md](verification/README.md)의 파일 5개를 `data/raw/`(Git 제외)에 두고 `npm --prefix app run market:load -- --source-dir ../data/raw`를 실행한다. `data/raw/`가 없으면 원본 대조 테스트 6개가 건너뛰어진다.

## 명령

| 명령 | 용도 |
|---|---|
| `verify:fast` | diff 공백·카탈로그·포맷·lint·typecheck·DB 비의존 테스트·production build. CI와 같은 검사 |
| `verify:db` | 테스트 DB를 쓰는 전체 Vitest |
| `verify:e2e` | production build로 Playwright(desktop·mobile) |
| `verify` | migration 상태부터 DB 테스트·E2E까지 전체 |
| `format` | Prettier로 포맷 |
| `db:migrate -- --name <이름>` | 새 migration 생성·적용 |
| `db:status` | migration 적용 상태 |

모두 `npm --prefix app run <명령>`으로 실행한다.

- schema를 바꾸면 실행 중인 개발 서버를 재시작한다. 재시작하지 않으면 이전 Prisma Client 때문에 500이 난다.
- 적재·하네스 명령은 Node 24가 TypeScript를 그대로 실행한다. 생성된 Prisma client가 확장자 없는 상대 import를 만들지 않도록 `app/prisma/schema.prisma`의 generator에 `moduleFormat = "esm"`, `importFileExtension = "ts"`를 둔다.
- 포맷은 Prettier가 정한다. `*.md`, 자금 카탈로그, migration은 포맷 대상이 아니다. 줄바꿈은 LF로 고정되어 있다.

## DB

- 컨테이너: `trendbench-mvp`, `127.0.0.1:5433`, 사용자 `trendbench`, DB `trendbench_mvp`
- 시작: `docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait`
- 정지: `docker compose --env-file infra/.env -f infra/compose.yaml stop`
- 같은 PC의 worktree들은 컨테이너, 테스트 DB, E2E 포트 3100을 공유한다. 개발 서버를 두 개 띄울 때는 `npm --prefix app run dev -- --port 3001`처럼 포트를 나눈다.
- Docker Desktop이 소켓(`sailor-ingest.sock`, `engine.sock`)을 `.stale`로 바꾸지 못한다는 오류로 시작하지 못할 때:
  1. Docker Desktop과 `com.docker.backend`를 종료한다.
  2. `wsl.exe --shutdown`을 실행한다.
  3. `%LOCALAPPDATA%\Docker\run`과 `%LOCALAPPDATA%\docker-secrets-engine`의 이름을 바꾼다(삭제하지 않는다).
  4. Docker Desktop을 다시 시작한다.

  이 오류는 앱이나 DB의 문제가 아니므로 볼륨을 지우지 않는다.

## CI

PR과 main push마다 `.github/workflows/check.yml`의 `check` job이 `verify:fast`를 실행한다. 로컬에서 `verify:fast`가 통과하면 CI도 통과한다. diff 공백 검사는 CI에서 PR base부터, 로컬에서 `origin/main`과의 merge-base부터 작업 트리까지 본다. DB 테스트와 E2E는 원격 CI에 없으므로 로컬 `verify`로 확인한다.

main은 GitHub ruleset `main protection`이 보호한다: squash 병합만, 필수 check `check` 통과, 병합 전 최신 main 반영, force push·삭제 금지. 기반 작업 동안 필수 승인은 0명이고, 협업을 시작할 때 올린다(#10). `check` job 이름을 바꾸면 ruleset의 필수 check도 함께 바꾼다.
