# TrendBench

서울의 공개 상권 관측값과 사용자의 재무 가정을 분리해, 예비 창업자가 필요자금·운영수지·상환 부담·정책자금 검토 후보를 판단하도록 돕는 Next.js 애플리케이션이다.

## 현재 상태

- 재무 계산, 인증, 계획 저장, revision 충돌, 불변 결과 저장
- 서울시 상권분석서비스의 상위 업종 매출·점포·고객 구성 분석
- 소진공 세부 업종 경쟁 점포 조회
- 사업 조건 입력과 계획 저장
- 사람 검수 카탈로그 기반 자금 후보와 확정 조건 대출 가정

세부 업종 매출·배달, 검수되지 않은 임대료·프랜차이즈 비교, 자동 대출 승인·예측 기능은 제공하지 않는다. 현재 기능·데이터 릴리스·미제공 범위는 [프로젝트 컨텍스트](docs/PROJECT_CONTEXT.md)를 단일 기준으로 삼는다.

## 먼저 읽을 문서

| 순서 | 문서 | 원본인 내용 |
|---|---|---|
| 1 | [AGENTS.md](AGENTS.md) | 저장소 규칙: single-writer 영역, 금지 명령, branch·commit 형식, 검증, 문서 동기화 |
| 2 | [PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) | 현재 기능·데이터 릴리스·변경 금지 계약·코드 지도 |
| 3 | [TEAM_AI_WORKFLOW.md](docs/TEAM_AI_WORKFLOW.md) | 작업 계약 Issue → worktree → PR → 병합 절차, Claude Code 설정 |
| 4 | [docs/README.md](docs/README.md) | 전체 문서 지도와 충돌 시 우선순위 |

Claude Code는 `CLAUDE.md`를 통해 1·2번을 자동으로 읽고, `.claude/settings.json`의 팀 공통 hook이 세션 상태 주입과 금지 명령 차단을 맡는다. 규칙을 도구별 파일에 복사하지 않는다.

## 구조

```text
app/                    Next.js App Router 단일 애플리케이션
app/src/features/       finance, plans, market, business-directory, funding
app/prisma/             schema와 순서가 있는 migration
app/catalog/funding/    사람이 검수하는 버전 고정 자금 카탈로그
app/scripts/            검증·부트스트랩·운영 데이터 적재
app/e2e/                데스크톱·모바일 핵심 사용자 흐름
infra/                  PostgreSQL 17 개발 구성
docs/                   현재 컨텍스트·제품·아키텍처·운영·검증 기록
```

## 빠른 시작

Node.js 24 LTS(`.nvmrc`), npm 11, Docker Desktop이 필요하다. 저장소 루트에서 실행한다.

```sh
npm --prefix app ci
npm --prefix app run bootstrap
npm --prefix app run dev
```

- 앱: <http://localhost:3000>
- 공개 상권 분석: <http://localhost:3000/markets>
- 자금 후보: <http://localhost:3000/funding>

`bootstrap`은 기존 환경파일을 덮어쓰지 않는다. 루트 `node_modules`는 앱 의존성 경로가 아니며 의존성은 `app/package-lock.json`으로 관리한다.

## 검증과 협업

검증 명령과 변경 종류별 기준은 [AGENTS.md §8](AGENTS.md#8-검증), 작업 계약·branch·PR·병합 절차는 [TEAM_AI_WORKFLOW.md](docs/TEAM_AI_WORKFLOW.md)가 원본이다. 새 작업은 GitHub의 **작업 계약** Issue로 시작한다.