# TrendBench

서울의 공개 상권 관측값과 사용자의 재무 가정을 분리해, 예비 창업자가 필요자금·운영수지·상환 부담·정책자금 후보를 판단하도록 돕는 Next.js 애플리케이션이다.

## 빠른 시작

Node.js 24(`.nvmrc`), npm 11, Docker Desktop이 필요하다. 저장소 루트에서 실행한다.

```sh
npm --prefix app ci
npm --prefix app run bootstrap
npm --prefix app run dev
```

앱은 <http://localhost:3000>, 상권 분석은 `/markets`, 자금 후보는 `/funding`이다. 운영 데이터(상권·점포·임대료·프랜차이즈·자금 카탈로그) 준비는 [로컬 데이터 준비](docs/DEVELOPMENT.md#로컬-데이터-준비)를 따른다.

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 작업 규칙: 데이터·계산 계약, 위험한 명령, commit·PR, 검증 |
| [PRODUCT.md](docs/PRODUCT.md) | 제품 목적·원칙·현재 기능·제외 범위 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 구조, 도메인별 코드·문서 위치 |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 환경·명령·DB·데이터 준비·CI |
| [decisions/](docs/decisions/README.md) | 되돌리기 어려운 결정(ADR) |
