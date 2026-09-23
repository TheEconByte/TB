# Claude Code 진입점

이 파일은 규칙을 담지 않는다. 아래 두 문서를 세션 시작 시 자동으로 불러온다. 규칙을 바꾸려면 원본 문서를 고친다.

@AGENTS.md
@docs/PROJECT_CONTEXT.md

팀 공통 Claude Code 설정(`.claude/settings.json`)은 세션 시작 시 작업 트리 상태를 알려 주고, AGENTS.md가 금지한 파괴적 명령과 환경파일 접근을 실행 전에 거부한다. 개인 설정은 `.claude/settings.local.json`에 둔다.
