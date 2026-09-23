# ADR 0001: 규칙 파일 하나와 도구 강제 중심의 팀 AI 하네스

- Status: Proposed
- Date: 2026-09-23
- Owners: jhjh0512
- Related issue/PR:
- Supersedes:

## Context

3명이 각자 Claude Code 세션으로 동시에 작업한다. 동시에 PR을 여는 AI 에이전트 사이의 충돌은 흔하다. [GitHub의 에이전트 PR 연구](https://arxiv.org/abs/2607.04697)에서 교차 에이전트 쌍의 텍스트 충돌률은 41.7%였다.

첫 하네스 초안은 규칙·현재 사실·절차·마일스톤을 12개 문서, 1,000줄 넘게 나눠 적었다. 여기에 single-writer 영역 7개, 필드 10개짜리 작업 계약 Issue, 문서 동기화 표를 두었다. 작성 5일 만에 사실과 다른 곳이 7군데 나왔다. 현재 사실 문서는 마일스톤이 끝날 때만 갱신하도록 되어 있었는데, 모든 세션이 이 문서를 자동으로 읽었다. 그래서 오래된 문맥을 계속 읽게 되는 구조였다.

문장으로는 막을 수 없는 충돌 원인도 있었다. `next dev`와 `next build`가 서로 다르게 다시 쓰는 `next-env.d.ts`, OS별 줄바꿈, 포매터 부재, 고정되지 않은 npm 버전, 같은 PC의 worktree가 공유하는 테스트 DB와 E2E 포트가 그것이다.

## Decision

1. **규칙은 `AGENTS.md` 하나에 둔다.** `CLAUDE.md`는 이 파일만 import한다. 협업 절차는 한 페이지짜리 `CONTRIBUTING.md`에 둔다. 제품 범위와 현재 기능은 `docs/PRODUCT.md`, 도메인 정책과 적재 기준 데이터는 `docs/domains/<도메인>.md`에 둔다. 문서는 코드와 같은 PR에서 고친다.
2. **작업 상태는 GitHub Issue와 Milestone에서만 관리한다.** 저장소에 상태 문서를 두지 않는다.
3. **충돌과 사고는 문장보다 도구로 막는다.**
   - GitHub: main 보호, 승인 1명, CI `check`, squash 병합
   - 포맷·버전: Prettier, `.editorconfig`, `.gitattributes`의 `eol=lf`, `.nvmrc`, `packageManager`. `next-env.d.ts`는 추적하지 않는다.
   - Claude Code: 환경파일 읽기 차단 권한, 세션 시작 상태 hook, 일부 파괴적 명령 차단 hook
4. **Claude Code를 팀 표준 AI 도구로 한다.** 다른 도구를 쓰게 되면 `AGENTS.md`를 가리키는 포인터 파일만 둔다.

## Alternatives considered

- **첫 초안 유지:** 규칙·사실·절차를 문서별로 나누고 single-writer 영역·작업 계약·문서 동기화 표로 관리하는 방식이다. 3명 규모에 비해 유지 비용이 크고, 이미 문서가 사실과 어긋났다. 기각한다.
- **문서 없이 구두 합의:** AI 에이전트는 구두 합의를 모른다. 기각한다.
- **도구별 규칙 파일 유지(GEMINI.md, copilot-instructions.md):** 현재 Claude Code만 쓴다. 기각한다.

## Consequences

- 장점: 에이전트와 사람이 읽을 규칙이 한 파일에 모인다. 매 세션 자동으로 읽는 문맥이 짧고 최신이다.
- 비용·위험:
  - hook은 명령 문자열 패턴으로 판단하므로 우회할 수 있다. 인간 리뷰를 대체하지 않는다.
  - hook이 Git Bash 또는 bash에서 `$CLAUDE_PROJECT_DIR`로 실행되므로 Windows 팀원은 Git for Windows가 필요하다.
  - 공유 파일 목록을 줄였으므로 인증·공통 계약 파일의 동시 수정은 리뷰에서 잡아야 한다.
- migration·호환성: DB·API 변경 없음.
- 운영·보안·데이터 영향: 자금 카탈로그와 적용된 migration은 포맷 대상에서 제외해 checksum과 적용 이력을 보존한다.

## Validation

- `npm --prefix app run verify:fast`가 포맷 검사를 포함해 통과한다.
- CI 필수 check `check`가 PR에서 `git diff --check`와 `format:check`를 실행한다.
- Claude Code 새 세션에서 세션 시작 상태가 문맥에 들어오고, `git reset --hard` 같은 명령이 hook에 의해 거부된다.
- 팀원 3명이 확인한 뒤 Status를 Accepted로 바꾼다.
