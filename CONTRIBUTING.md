# 협업 절차

3명이 각자 Claude Code 세션으로 동시에 작업하는 것을 전제로 한다. 규칙은 [AGENTS.md](AGENTS.md), 실행 방법은 [DEVELOPMENT.md](docs/DEVELOPMENT.md)를 따른다.

## 흐름

1. **Issue**: GitHub에서 New issue → **작업** 양식으로 목표·범위·완료 조건을 적고 자신을 assignee로 지정한다. assignee가 있으면 진행 중이다. 오타·깨진 링크 같은 작은 문서 수정은 Issue 없이 PR만 연다.
2. **겹침 확인**: 같은 파일을 고치는 열린 Issue·PR이 있으면 먼저 순서를 정한다. [공유 파일](AGENTS.md#5-공유-파일)은 한 번에 PR 하나만 고친다.
3. **branch와 worktree**: 동시 작업은 worktree로 나눈다. 같은 폴더를 여러 AI 세션에 주지 않는다.

   ```sh
   git fetch origin
   git worktree add ../TB-12 -b feat/12-result-compare origin/main
   ```

   새 worktree에는 환경파일이 없다. [한 PC의 여러 worktree](docs/DEVELOPMENT.md#한-pc의-여러-worktree)를 따라 준비한다.
4. **Claude Code**: worktree 폴더에서 실행하고 첫 요청에 Issue 번호를 준다.
5. **PR**: 제목은 [AGENTS.md §6](AGENTS.md#6-commitbranchpr) 형식, 본문 첫 줄은 `Closes #<번호>`. 템플릿의 검증 결과를 채운다.
6. **리뷰·병합**: 다른 팀원 1명이 승인하고 CI `check`가 통과하면 squash 병합한다.

## 리뷰할 때 볼 것

- Issue의 범위를 벗어난 변경이 없는가
- [데이터·계산 계약](AGENTS.md#3-데이터계산-계약)을 지키는가: `null`/0/`UNKNOWN`, 관측값/사용자 가정, 상위/세부 업종 범위
- 로딩·빈 결과·자료 부족·4xx/5xx를 처리하고, 테스트가 그것을 확인하는가
- 의존성 변경이면 lockfile diff와 `npm audit`을 직접 확인했는가

AI 리뷰만으로 승인하지 않는다. AI가 지적한 내용도 코드에서 확인한다. 충돌은 그 변경을 이해하는 작성자가 해결하고, `ours`/`theirs` 일괄 선택이나 생성 코드 재생성으로 덮지 않는다. 계약을 바꾸는 PR과 그 계약을 쓰는 PR이 있으면 계약 PR을 먼저 병합한다.

## GitHub 설정

| 항목 | 값 |
|---|---|
| main 보호 | PR 필수, 승인 1명(새 push 시 재승인), conversation resolution, force push·삭제 금지, admin 포함 우회 없음 |
| 필수 check | `check` (workflow `App checks`: diff 공백·포맷·lint·typecheck·unit test·build) |
| 병합 | squash만. commit 제목은 PR 제목, 병합 후 branch 자동 삭제 |
| 권한 | 조직 team `trendbench-dev` write |

원격 CI는 DB·E2E를 실행하지 않는다. 설정을 바꾸면 이 표를 같은 PR에서 고친다.

## Claude Code 설정

- `CLAUDE.md`가 `AGENTS.md`를 자동으로 읽는다.
- `.claude/settings.json`은 환경파일 읽기를 막는 권한 규칙과 두 hook을 둔다. 세션 시작 hook은 branch·HEAD·작업 트리 상태를 알려 주고, 가드 hook은 일부 파괴적 명령을 막는다. hook은 Node로 작성되어 Windows에서는 Git for Windows가 필요하다.
- 가드 hook은 명령 문자열 전체를 검사한다. Issue·PR 본문에 금지 명령 예시가 있으면 파일로 만든 뒤 `--body-file`로 넘긴다. hook 규칙을 바꾸면 `app/scripts/guard-commands.test.ts`에 막을 명령과 허용할 명령을 추가한다.
- 개인 설정은 `.claude/settings.local.json`(Git 제외)에 두고, 팀 공통 hook을 개인 설정으로 끄지 않는다.
