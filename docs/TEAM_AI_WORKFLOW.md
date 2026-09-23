# 팀 AI 개발 공동 지침

이 문서는 여러 팀원이 각자의 AI 에이전트 세션으로 동시에 TrendBench를 개발할 때 충돌, 문맥 분기, 검증 누락을 막는 운영 규칙이다. 저장소 규칙은 [AGENTS.md](../AGENTS.md), 제품·데이터 계약은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)가 우선한다. 이 문서는 사람이 따르는 절차의 원본이다.

## 1. 왜 별도 규칙이 필요한가

AI는 코드 생성 속도를 높이지만 저장소의 합의, 다른 작업자의 미커밋 변경, 운영 데이터의 의미를 자동으로 공유하지 않는다. DORA 2025는 AI를 조직의 강점과 약점을 확대하는 증폭기로 설명한다. 동시 AI PR 연구에서는 교차 에이전트 쌍의 텍스트 충돌률이 41.7%, 동일 에이전트 쌍은 19.8%였고, 충돌 파일의 84.4%가 소스 코드였으며 약 42%는 add/add 또는 modify/delete 같은 구조 충돌이었다.

GitHub는 작은 단일 목적 PR이 검토하기 쉽고 안전하다고 설명하며, 필수 상태 검사는 최신 commit SHA에서 통과해야 한다고 명시한다. Git worktree는 각 작업에 별도 HEAD와 index를 제공한다. GitHub Copilot 문서도 AI 리뷰가 모든 문제를 찾는다고 보장하지 않으며 인간 리뷰를 병행하라고 요구한다. 일부 dependency 관리 파일은 Copilot code review 대상에서 제외되므로 AI 리뷰 통과를 lockfile·공급망 검증으로 해석할 수도 없다.

### TrendBench에서 이미 확인한 혼란 사례

| 사례 | 원인 | 이 문서의 방지 규칙 |
|---|---|---|
| Prisma 필드는 생겼지만 DB에 migration이 없어 런타임 실패 | 코드와 DB 상태를 한 작업으로 보지 않음 | schema+migration+두 DB 적용+DB 테스트를 한 소유자가 수행 |
| 제한된 환경의 Docker 권한 오류를 DB 손상으로 오인 | 실행 환경과 제품 결함을 구분하지 않음 | 실패 원문·실행 환경을 기록하고 데이터 초기화를 금지 |
| 과거 README와 최신 TASKS가 서로 다른 완료 상태를 설명 | 같은 사실을 여러 문서에 중복 기록 | PROJECT_CONTEXT를 현재 사실의 단일 진입점으로 사용 |
| 비동기 상권 요청의 늦은 응답이 새 선택을 덮어씀 | UI 상태 경쟁을 정상 흐름만으로 검증 | 빠른 선택 변경·오류·빈 상태를 회귀 테스트 |
| 미검수 카탈로그를 데이터가 없는 것으로 오해 | `UNKNOWN`, 빈 결과, unavailable을 섞음 | 상태 의미와 fail-closed 계약을 변경 금지 계약으로 고정 |
| 빌드 도구가 기존 `next-env.d.ts` 변경을 재생성 | 도구 생성 변경과 사용자 변경을 구분하지 않음 | 시작·종료 시 `git status`, 기존 변경 보존, 파일별 소유권 확인 |

## 2. 작업 흐름 한눈에

```text
작업 계약 Issue 작성·assign
  → 겹치는 Issue·PR 확인
  → origin/main에서 branch + worktree 생성
  → worktree에서 Claude Code 실행, Issue 링크 전달
  → 구현·검증 (AGENTS.md §8)
  → PR (Closes #N, 검증 증거)
  → 인간 리뷰 → 최신 main 기준 CI 통과 → 병합 → Issue 자동 종료
```

규칙(무엇을 하면 안 되는가)은 [AGENTS.md](../AGENTS.md)가 원본이다. 이 문서는 사람이 따르는 절차만 다룬다.

## 3. 작업 시작 절차

### 3.1 작업 계약 = GitHub Issue

- GitHub에서 **New issue → 작업 계약** 양식([work-contract.yml](../.github/ISSUE_TEMPLATE/work-contract.yml))으로 만든다. Issue 번호가 작업 ID다.
- 인간 책임자를 assignee로 지정한다. assignee가 있는 Issue가 "진행 중" 예약이다. 저장소 안에 별도의 잠금 파일이나 상태표를 만들지 않는다.
- 작업 계약이 없는 AI 세션은 조사와 제안까지만 할 수 있고 파일을 수정하지 않는다.
- 진행 상태·완료 여부의 원본은 Issue다. [TASKS.md](TASKS.md)는 마일스톤 요약이며 기능 PR에서 수정하지 않는다.

### 3.2 겹치는 작업 확인

- 소유 경로가 열린 Issue·PR과 겹치는지 확인한다. 예: `gh pr list --state open --search "<경로 또는 키워드>"`, 열린 Issue의 "소유 경로" 항목.
- 경로가 겹치면 병렬로 진행하지 않고 범위를 나누거나 선행 PR을 먼저 합친다.
- [AGENTS.md §3](../AGENTS.md#3-single-writer-영역)의 single-writer 영역은 해당 영역 owner에게 작은 선행 PR을 요청한다.
- 읽기 전용 조사·테스트는 병렬화할 수 있지만 동일 파일 쓰기는 병렬화하지 않는다.

### 3.3 branch와 worktree

```sh
git fetch origin
git worktree add ../TB-12 -b feat/12-result-compare origin/main
```

- branch 이름은 [AGENTS.md §7](../AGENTS.md#7-branchcommitpr-형식)을 따른다.
- 동시 작업은 `git worktree`로 분리한다. 폴더 복사본이나 같은 checkout을 여러 AI에 공유하지 않는다.
- 새 worktree는 환경파일이 없다. [DEVELOPMENT.md](DEVELOPMENT.md#한-pc의-여러-worktree)에 따라 사람이 준비한다.
- 작업 중 main이 바뀌면 무조건 자동 rebase하지 않는다. 계약과 충돌 가능성을 먼저 확인한다.

### 3.4 Claude Code 세션 시작

- worktree 폴더에서 Claude Code를 실행한다. `CLAUDE.md`가 `AGENTS.md`와 `PROJECT_CONTEXT.md`를 자동으로 불러오고, `.claude/settings.json`의 세션 시작 hook이 branch·HEAD·작업 트리 상태를 알려 준다.
- 첫 요청에는 Issue 링크나 번호를 준다. "알아서 전부 구현"만 전달하지 않는다.
- AI에게 commit·push·PR 생성 권한을 줄지는 Issue의 "AI 권한" 항목을 따른다.
- 개인 선호 설정은 `.claude/settings.local.json`(Git 제외)에 둔다. 팀 공통 hook·권한 규칙을 개인 설정으로 끄지 않는다.

## 4. 구현 중 사람이 확인할 것

### 코드와 의존성

- 새 추상화는 두 번째 실제 사용처가 있거나 명확한 계약 경계가 있을 때만 추가한다.
- AI가 제안한 패키지·API·버전은 설치된 타입과 공식 문서로 확인한다.
- dependency 변경은 package와 lockfile diff, 설치 결과, audit를 사람이 확인한다. AI 리뷰가 해당 파일을 검토했다고 가정하지 않는다.
- 외부 데이터와 시간에 민감한 사실은 출처와 확인일을 기록한다.

### UI와 비동기 상태

- 성공 화면만 보지 않는다. 로딩, 빈 결과, 자료 부족, 4xx/5xx, 빠른 선택 변경, 모바일을 확인한다.
- 관측 데이터와 사용자 가정의 라벨을 지우거나 한 숫자로 합치지 않는다.
- 접근성 이름과 키보드 흐름을 유지한다.

### 문서

변경 종류별로 고칠 문서는 [AGENTS.md §9](../AGENTS.md#9-문서-동기화)의 표 하나만 따른다. 도메인 정책은 `docs/domains/<도메인>.md`에 있으므로 서로 다른 도메인 작업은 서로 다른 문서를 고친다.

## 5. 검증과 인수인계

검증 명령과 변경 종류별 기준은 [AGENTS.md §8](../AGENTS.md#8-검증)이 원본이다. 실행하지 못한 검사는 명령, 이유, 남은 위험을 적는다.

### 인수인계 형식

PR 본문 또는 Issue 댓글에 남긴다.

```md
변경 결과:
변경 파일과 이유:
계약/API/DB 영향:
실행한 검증과 결과:
실행하지 못한 검증:
데이터 출처와 기준일:
알려진 위험·후속 작업(Issue 번호):
현재 HEAD와 작업 트리 상태:
```

채팅 요약만 남기지 않는다. 중요한 계약과 운영 절차는 repository 문서·테스트·migration에 남긴다.

## 6. 리뷰와 병합

- PR은 하나의 Issue, 즉 하나의 사용자 가치 또는 하나의 기반 계약만 다룬다.
- AI 작성 PR도 인간 작성 PR과 같은 리뷰·테스트·보안 기준을 적용한다.
- 리뷰어는 "코드가 그럴듯한가"가 아니라 요구사항, 비범위, 데이터 의미, 실패 상태, 테스트 증거를 확인한다.
- AI 리뷰만으로 승인하지 않는다. AI 리뷰 피드백도 사람이 재현하거나 코드에서 확인한다.
- base branch 최신 상태와 최신 commit SHA의 필수 검사를 확인한 뒤 병합한다.
- 충돌은 해당 변경을 이해하는 작성자가 해결한다. `ours`/`theirs` 전체 선택이나 생성 코드 재생성으로 덮지 않는다.
- 병합 순서는 `schema/공통 계약 → 서버 → UI → 후속 문서`처럼 의존성 방향을 따른다. 하나의 원자적 변경이면 한 PR에 함께 둔다.
- 대형 작업은 작은 stacked PR로 나눌 수 있지만 각 PR은 독립 검증 가능해야 한다.
- PR 작성자는 자기 PR을 승인할 수 없다. 다른 팀원 1명의 승인이 필요하다.
- squash 병합 시 PR 제목이 main의 commit 메시지가 된다. 병합 전에 제목이 [AGENTS.md §7](../AGENTS.md#7-branchcommitpr-형식) 형식인지 확인한다.
- 마일스톤의 마지막 Issue가 닫히면 [TASKS.md](TASKS.md)와 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)를 갱신하는 작업 계약 Issue를 따로 만들어 한 PR로 반영한다.

## 7. GitHub 저장소 설정

`TheEconByte/TB`(public)의 현재 설정이다. 설정을 바꾸면 이 절을 같은 PR에서 고친다.

| 항목 | 현재 값 |
|---|---|
| main ruleset `main protection` | PR 필수, 승인 1명, 새 push 시 기존 승인 해제, conversation resolution 필수, force push·삭제 금지, bypass 없음(admin 포함) |
| 필수 status check | `check` (workflow `App checks`의 job 이름). 최신 main 기준으로 통과해야 병합 가능 |
| 병합 방식 | squash만 허용. commit 제목은 PR 제목, 병합 후 branch 자동 삭제 |
| 접근 권한 | 조직 team `trendbench-dev`에 write |
| CODEOWNERS | 없음. 실제 담당자가 정해진 뒤에만 추가하고 가짜 사용자명은 넣지 않는다 |

- CI `check`는 PR diff 공백·포맷·lint·typecheck·unit test·build만 실행한다. DB·E2E는 원격 CI에 없으므로 DB·E2E 변경 PR은 로컬 `verify` 결과를 PR에 명시한다.
- PR 수가 많아지면 merge queue 도입을 검토한다.

## 8. AI 도구 설정

팀 표준 도구는 Claude Code다.

| 파일 | 역할 |
|---|---|
| `CLAUDE.md` | `AGENTS.md`와 `PROJECT_CONTEXT.md`를 `@` import로 자동 로드. 규칙을 직접 담지 않음 |
| `.claude/settings.json` | 팀 공통 권한 규칙과 hook. 세션 시작 상태 주입, 금지 명령·환경파일 접근 차단 |
| `.claude/hooks/*.mjs` | hook 구현. Node로 작성해 Windows·macOS에서 같게 동작 |
| `.claude/settings.local.json` | 개인 설정. Git 제외 |

- 규칙을 도구별 파일에 복사하지 않는다. 복사본은 곧 서로 다른 진실이 된다.
- 다른 AI 도구를 추가하면 해당 도구의 진입 파일은 `AGENTS.md`를 가리키는 포인터만 둔다(`GEMINI.md`, `.github/copilot-instructions.md`가 예시다).
- subagent가 repository instructions를 자동 상속한다고 가정하지 않는다. 파일을 수정하는 subagent에는 Issue 번호와 소유 경계를 명시적으로 전달한다.
- AI가 생성한 요약보다 현재 branch의 코드·테스트·문서를 우선한다.
- 가드 hook은 명령 문자열 전체를 검사한다. heredoc이나 인자 안에 금지 명령 문구가 들어 있으면 실제로 실행하지 않아도 차단된다(예: Issue 본문에 적힌 금지 명령 예시). 이런 본문은 파일 쓰기 도구로 파일을 만든 뒤 `--body-file`처럼 파일 경로로 넘긴다.

## 9. 근거 자료

- [DORA 2025 State of AI-assisted Software Development](https://dora.dev/research/2025/dora-report/) — AI는 기존 조직 역량과 약점을 증폭한다.
- [AI Agent Pull Requests on GitHub](https://arxiv.org/abs/2607.04697) — 동시 에이전트 PR의 빈도와 교차 에이전트 충돌률을 분석했다.
- [Git worktree documentation](https://git-scm.com/docs/git-worktree) — branch별 HEAD와 index가 분리된 working tree를 제공한다.
- [GitHub: Helping others review your changes](https://docs.github.com/en/pull-requests/concepts/helping-others-review-your-changes) — 작고 집중된 PR이 검토와 병합에 유리하다.
- [GitHub: Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) — 리뷰·필수 검사·merge queue로 기본 branch를 보호한다.
- [GitHub: Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) — AI 리뷰는 문제를 놓치거나 잘못 판단할 수 있어 인간 검토가 필요하다.
- [GitHub: Repository custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) — 저장소별 build·test·layout 규칙을 version control에 둔다.
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) — 일부 subagent는 repository instructions를 기본으로 받지 않는다.

이 근거들은 AI 사용을 금지하라는 결론이 아니라, 격리·작은 변경·명시적 컨텍스트·자동 검증·인간 책임이 있어야 팀 생산성으로 이어진다는 결론을 뒷받침한다.
