// PreToolUse(Bash|PowerShell) hook. AGENTS.md §4가 사람에게 맡긴 파괴적 명령과 환경파일 접근을 실행 전에 거부한다.
// 명령 문자열 패턴으로 판단하므로 우회할 수 있다. 규칙을 바꾸면 app/scripts/guard-commands.test.ts에 사례를 추가한다.
import { readFileSync } from 'node:fs';

const RULES = [
  [/\bprisma\s+migrate\s+reset\b/, 'prisma migrate reset은 DB를 초기화합니다. 새 corrective migration을 추가하세요.'],
  [/\bdocker\s+compose\b.*\bdown\b.*(\s-v\b|--volumes\b)/, 'docker compose down -v는 DB 볼륨을 삭제합니다. stop을 사용하세요.'],
  [/\bdocker\s+(volume\s+(rm|prune)|system\s+prune\b.*--volumes)\b/, 'Docker 볼륨 삭제는 DB 데이터를 지웁니다.'],
  [/\bgit\s+push\b.*(\s-f\b|--force\b|--force-with-lease\b|\s\+\S)/, 'force push는 사람이 직접 판단합니다.'],
  [/\bgit\s+reset\b.*--hard\b/, 'git reset --hard는 기존 변경을 지웁니다.'],
  [/\bgit\s+clean\b.*(\s-[a-zA-Z]*f|--force\b)/, 'git clean -f는 추적되지 않은 파일을 지웁니다.'],
  [/\bgit\s+stash\b(?!\s+(list|show)\b)/, '기존 변경을 stash로 숨기지 않습니다.'],
  [/\bgit\s+checkout\b.*(\s--\s|\s\.(\s|$)|\s-f\b|--force\b)/, 'git checkout으로 작업 트리 변경을 버리지 않습니다.'],
  [/\bgit\s+switch\b.*(\s-f\b|--force\b|--discard-changes\b)/, 'git switch로 작업 트리 변경을 버리지 않습니다.'],
  // index만 되돌리는 --staged는 허용하고, 작업 트리를 건드리는 restore는 막는다.
  [/\bgit\s+restore\b(?!(?=.*(--staged|\s-S\b))(?!.*(--worktree|\s-W\b)))/, 'git restore로 작업 트리 변경을 버리지 않습니다.'],
  [/\b(rm|rmdir|del|rd|Remove-Item)\b.*\bdata[/\\]raw\b/i, '운영 원본(data/raw)은 사람이 직접 관리합니다.'],
];

// --env-file 인자로 경로만 넘기는 것은 허용하고, 내용을 출력·복사·편집하는 참조만 막는다.
const SECRET_FILE =
  /(?:^|[\s'"=/\\])(?<!--env-file(?:-if-exists)?[=\s])(?:\.env\.local|\.env\.test\.local|infra[/\\]\.env|app[/\\]\.env)(?=$|[\s'";|])/;

// 파일이 있는지만 확인하는 명령은 값을 드러내지 않으므로 환경파일 검사에서 뺀다.
const EXISTENCE_CHECKS = [
  /\bTest-Path\s+(?:-(?:Literal)?Path\s+)?\S+/gi,
  /\btest\s+-[efs]\s+\S+/g,
  /\[\s+-[efs]\s+\S+\s+\]/g,
];

function decide(command) {
  const line = command.replace(/\s+/g, ' ');
  for (const [pattern, reason] of RULES) {
    if (pattern.test(line)) return reason;
  }
  const withoutChecks = EXISTENCE_CHECKS.reduce((text, pattern) => text.replace(pattern, ' '), line);
  if (SECRET_FILE.test(withoutChecks))
    return '환경파일(.env.local, .env.test.local, infra/.env, app/.env)의 값은 읽거나 출력하지 않습니다.';
  return null;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
const reason = decide(command);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[TrendBench AGENTS.md] ${reason} 필요하면 사람이 직접 실행합니다.`,
      },
    }),
  );
}
