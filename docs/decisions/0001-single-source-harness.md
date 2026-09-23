# ADR 0001: 단일 원본 문서와 기계적 강제 기반의 팀 AI 하네스

- Status: Proposed
- Date: 2026-09-23
- Owners: jhjh0512
- Related issue/PR:
- Supersedes:

## Context

팀원 각자가 Claude Code 세션으로 동시에 작업한다. 기존 문서는 변경 금지 계약·협업 규칙·single-writer 목록·운영 릴리스 값을 4~7개 문서에 복사해 두었고, 복사본 사이에 이미 항목 수와 범위가 달랐다. 또한 모든 기능 PR이 `PROJECT_CONTEXT.md`, `TASKS.md`, `DEVELOPMENT.md`를 고치도록 되어 있어 문서 자체가 병합 충돌 지점이었다.

문서로 막을 수 없는 충돌 원인도 있었다. `next dev`와 `next build`가 서로 다르게 다시 쓰는 `next-env.d.ts`, OS별 줄바꿈, 포매터 부재, 고정되지 않은 npm 버전, 같은 PC의 worktree가 공유하는 테스트 DB와 E2E 포트가 그것이다. 금지 명령과 작업 시작 절차는 문장으로만 존재했다.

## Decision

1. **한 종류의 사실·규칙은 한 문서에만 쓴다.**
   - 규칙: `AGENTS.md`
   - 현재 사실과 변경 금지 계약: `docs/PROJECT_CONTEXT.md`
   - 사람의 절차: `docs/TEAM_AI_WORKFLOW.md`
   - 도메인 정책: `docs/domains/<도메인>.md`
   - 다른 문서는 링크만 한다.
2. **작업 상태의 원본은 GitHub Issue다.** 작업 ID는 Issue 번호다. `TASKS.md`는 마일스톤 요약이며 기능 PR에서 고치지 않는다.
3. **Claude Code를 팀 표준 도구로 한다.**
   - `CLAUDE.md`는 `@AGENTS.md`와 `@docs/PROJECT_CONTEXT.md`를 import한다.
   - `.claude/settings.json`의 hook은 세션 시작 상태를 넣어 준다.
   - 같은 hook이 금지 명령과 환경파일 접근을 실행 전에 거부한다.
4. **포맷·줄바꿈·버전을 도구가 결정한다.**
   - Prettier(`format:check`를 verify와 CI에 포함)
   - `.editorconfig`, `.gitattributes`의 `eol=lf`
   - `.nvmrc`, `packageManager`
   - `next-env.d.ts`는 추적하지 않는다.

## Alternatives considered

- **문서 복사 유지와 주기적 대조:** 대조 책임자가 없으면 복사본이 계속 어긋난다. 기각한다.
- **작업 상태를 TASKS.md에 유지:** 모든 PR이 같은 파일을 고쳐 충돌한다. 기각한다.
- **도구별 규칙 파일(GEMINI.md, copilot-instructions.md)을 각각 유지:** 현재 팀은 Claude Code만 쓴다. 다른 도구를 추가하면 포인터만 둔다.
- **Prettier 도입 보류:** 코드가 적은 지금이 전체 포맷 비용이 가장 작다. 보류하면 에이전트마다 스타일이 달라 충돌이 누적된다.

## Consequences

- 장점:
  - 에이전트가 읽는 규칙이 하나로 모인다.
  - 서로 다른 도메인 작업은 서로 다른 문서를 고친다.
  - 파괴적 명령이 사람 확인 없이 실행되지 않는다.
- 비용·위험:
  - 최초 1회 전체 포맷 commit이 생긴다. `.git-blame-ignore-revs`에 등록한다.
  - hook은 명령 문자열 패턴으로 판단하므로 우회 가능한 방어선이다. 인간 리뷰를 대체하지 않는다.
  - hook이 Git Bash 또는 bash에서 `$CLAUDE_PROJECT_DIR`로 실행되므로 Windows 팀원은 Git for Windows가 필요하다.
- migration·호환성: DB·API 변경 없음.
- 운영·보안·데이터 영향:
  - 환경파일 읽기를 권한 규칙과 hook으로 막는다.
  - 자금 카탈로그와 적용된 migration은 포맷 대상에서 제외해 checksum과 적용 이력을 보존한다.

## Validation

- `npm --prefix app run verify:fast`가 포맷 검사를 포함해 통과한다.
- CI `App checks`가 PR에서 `git diff --check`와 `format:check`를 실행한다.
- Claude Code 새 세션에서 세션 시작 상태가 문맥에 들어오고, `git reset --hard` 같은 명령이 hook에 의해 거부된다.
- 팀원 전원이 이 ADR을 확인한 뒤 Status를 Accepted로 바꾼다.
