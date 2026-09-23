# TrendBench

서울의 공개 상권 관측값과 사용자의 재무 가정을 분리해, 예비 창업자가 필요자금·운영수지·상환 부담·정책자금 검토 후보를 판단하도록 돕는 Next.js 애플리케이션이다.

## 현재 상태

현재 제공하는 기능·제공하지 않는 기능·운영 데이터 릴리스는 [PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) §2~§4가 원본이다.

## 먼저 읽을 문서

| 순서 | 문서 | 원본인 내용 |
|---|---|---|
| 1 | [AGENTS.md](AGENTS.md) | 저장소 규칙: single-writer 영역, 금지 명령, branch·commit 형식, 검증, 문서 동기화 |
| 2 | [PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) | 현재 기능·데이터 릴리스·변경 금지 계약·코드 지도 |
| 3 | [TEAM_AI_WORKFLOW.md](docs/TEAM_AI_WORKFLOW.md) | 작업 계약 Issue → worktree → PR → 병합 절차, Claude Code 설정 |
| 4 | [docs/README.md](docs/README.md) | 전체 문서 지도와 충돌 시 우선순위 |

Claude Code는 `CLAUDE.md`를 통해 1·2번을 자동으로 읽고, `.claude/settings.json`의 팀 공통 hook이 세션 상태 주입과 금지 명령 차단을 맡는다. 규칙을 도구별 파일에 복사하지 않는다.

## 구조

단일 Next.js 앱(`app/`)과 PostgreSQL(`infra/`)로 구성된다. 디렉터리별 책임은 [PROJECT_CONTEXT.md §7](docs/PROJECT_CONTEXT.md#7-코드-지도), 도메인·테스트 지도는 [ARCHITECTURE.md](docs/ARCHITECTURE.md)를 따른다.

## 빠른 시작

Node.js 24 LTS(`.nvmrc`), npm 11, Docker Desktop이 필요하다. Windows에서는 Claude Code hook 실행에 Git for Windows(Git Bash)가 필요하다. 저장소 루트에서 실행한다.

```sh
npm --prefix app ci
npm --prefix app run bootstrap
npm --prefix app run dev
```

- 앱: <http://localhost:3000>
- 공개 상권 분석: <http://localhost:3000/markets>
- 자금 후보: <http://localhost:3000/funding>

`bootstrap`은 기존 환경파일을 덮어쓰지 않고 운영 데이터도 적재하지 않는다. 상권·점포 데이터와 원본 대조 테스트에 필요한 준비는 [DEVELOPMENT.md의 로컬 데이터 준비](docs/DEVELOPMENT.md#로컬-데이터-준비)를 따른다. 의존성은 `app/package-lock.json`으로 관리한다.

## 검증과 협업

검증 명령과 변경 종류별 기준은 [AGENTS.md §8](AGENTS.md#8-검증), 작업 계약·branch·PR·병합 절차는 [TEAM_AI_WORKFLOW.md](docs/TEAM_AI_WORKFLOW.md)가 원본이다. 새 작업은 GitHub의 **작업 계약** Issue로 시작한다.