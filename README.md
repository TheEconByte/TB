# TrendBench

서울의 공개 상권 관측값과 사용자의 재무 가정을 분리해, 예비 창업자가 필요자금·운영수지·상환 부담·정책자금 검토 후보를 판단하도록 돕는 Next.js 애플리케이션이다. 현재 제공하는 기능은 [PRODUCT.md](docs/PRODUCT.md#현재-제공-기능)에 있다.

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

`bootstrap`은 기존 환경파일을 덮어쓰지 않고 운영 데이터도 적재하지 않는다. 상권·점포 데이터 준비는 [로컬 데이터 준비](docs/DEVELOPMENT.md#로컬-데이터-준비)를 따른다.

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 규칙: 데이터·계산 계약, 금지 명령, commit 형식, 검증 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 협업 절차: Issue → worktree → PR → 병합 |
| [PRODUCT.md](docs/PRODUCT.md) | 제품 범위, 현재 제공 기능 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 구조, 도메인·코드 지도 |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 실행·DB·데이터 준비·CI |
| [decisions/](docs/decisions/README.md) | 되돌리기 어려운 결정(ADR) |
| [SPRINT.md](docs/SPRINT.md) | 데모 스프린트(~9/28) 작업 패키지·인터페이스·일정. 데모 후 삭제 |

작업 진행 상태는 GitHub Issue와 Milestone에서 관리한다.
