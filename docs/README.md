# TrendBench 문서 지도

사람과 AI는 추측으로 전체 문서를 섞어 읽지 말고 이 지도에서 작업에 필요한 원본을 고른다. **한 종류의 사실·규칙은 한 문서에만 쓴다.** 다른 문서는 그 원본을 링크한다.

## 필수 진입 순서

1. [`AGENTS.md`](../AGENTS.md) — 규칙
2. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — 현재 사실과 변경 금지 계약
3. [TEAM_AI_WORKFLOW.md](TEAM_AI_WORKFLOW.md) — 작업 절차
4. 작업할 도메인의 `domains/<도메인>.md`

Claude Code는 `CLAUDE.md`를 통해 1·2번을 세션 시작 시 자동으로 읽는다.

## 원본 문서

| 질문 | 원본 | 담는 것 |
|---|---|---|
| 무엇을 하면 안 되고 어떻게 검증하는가 | [AGENTS.md](../AGENTS.md) | single-writer 영역, 금지 명령, branch·commit 형식, 검증 기준, 문서 동기화 표 |
| 지금 무엇이 실제로 동작하는가 | [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) | 현재 기능, 운영 데이터 릴리스, 미제공 범위, 변경 금지 계약, 코드 지도 |
| 여러 팀원과 AI가 어떻게 나누는가 | [TEAM_AI_WORKFLOW.md](TEAM_AI_WORKFLOW.md) | 작업 계약 Issue, worktree, 리뷰·병합, Claude Code 설정 |
| 누구를 위해 무엇을 만드는가 | [PRODUCT.md](PRODUCT.md) | 사용자 목적, 제품 원칙과 범위 |
| 어느 마일스톤이 끝났고 다음은 무엇인가 | [TASKS.md](TASKS.md) | 마일스톤 요약. 개별 작업 상태는 GitHub Issue |
| 코드는 어디에 있는가 | [ARCHITECTURE.md](ARCHITECTURE.md) | 도메인·API·테스트 지도, 변경 위치, 검증 계층 |
| 어떻게 실행하는가 | [DEVELOPMENT.md](DEVELOPMENT.md) | 환경, 명령, 포맷, DB, CI, 한 PC의 여러 worktree |
| 도메인 정책은 무엇인가 | [domains/](DEVELOPMENT.md#도메인별-구현-계약) | 도메인별 API·적재·계산 정책과 테스트 범위 |
| 되돌리기 어려운 결정을 어디에 남기는가 | [decisions/README.md](decisions/README.md) | ADR 대상, 형식, 변경 이력 |
| 공공 원본을 어떻게 재현 검증하는가 | [verification/README.md](verification/README.md) | 원본 준비와 검증 스크립트 |

## 역사·근거 문서

아래 문서는 결정 근거와 당시 검증을 보존하지만 현재 구현 지침이 아니다.

| 문서 | 용도 |
|---|---|
| [11_Project_Direction_Analysis.md](11_Project_Direction_Analysis.md) | 2026-09-09 방향 전환 기록 |
| [12_Simplified_MVP_Technical_Plan.md](12_Simplified_MVP_Technical_Plan.md) | 초기 MVP 설계와 계산 근거 |
| [13_Data_API_Feasibility_Verification.md](13_Data_API_Feasibility_Verification.md) | 당시 공공데이터·지원 공고 검증 증거 |
| [REPOSITORY_REORGANIZATION.md](REPOSITORY_REORGANIZATION.md) | 2026-09-18 저장소 개편 기록 |

역사 문서의 테이블 수, 완료 상태, 데이터 기준일이 현재 문서와 다르면 현재 원본 문서를 따른다. 단, 계산식이나 데이터 의미를 바꾸려면 역사 문서의 근거도 검토하고 새 ADR을 남긴다.

## 문서 우선순위와 충돌 처리

1. 사용자의 최신 명시적 요구
2. `AGENTS.md`의 저장소 안전·검증 규칙
3. `PROJECT_CONTEXT.md`의 현재 사실과 변경 금지 계약
4. `PRODUCT.md`의 제품 범위
5. `docs/domains/`, `ARCHITECTURE.md`, `DEVELOPMENT.md`의 구현·운영 절차
6. `TASKS.md`의 마일스톤 요약
7. 역사·근거 문서

코드·schema·migration·테스트·실제 실행 결과가 문서와 다르면 조용히 코드만 따르지 않는다. 불일치를 보고하고, 최신 사실을 확인한 뒤 코드와 원본 문서를 같은 작업에서 맞춘다.

변경 종류별로 고칠 문서는 [AGENTS.md §9](../AGENTS.md#9-문서-동기화)의 표가 원본이다.
