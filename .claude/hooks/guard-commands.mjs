// PreToolUse(Bash|PowerShell) hook. AGENTS.md가 금지한 파괴적 명령과 비밀 파일 접근을 실행 전에 거부한다.
// 규칙의 근거는 AGENTS.md이며, 여기서는 기계적으로 막을 수 있는 것만 다룬다.
import { readFileSync } from 'node:fs';

const RULES = [
  [/\bprisma\s+migrate\s+reset\b/, 'prisma migrate reset은 DB를 초기화합니다. 새 corrective migration을 추가하세요.'],
  [/\bdocker\s+compose\b.*\bdown\b.*(\s-v\b|--volumes\b)/, 'docker compose down -v는 DB 볼륨을 삭제합니다. stop을 사용하세요.'],
  [/\bgit\s+push\b.*(\s-f\b|--force\b|--force-with-lease\b)/, 'force push는 사람이 직접 판단합니다.'],
  [/\bgit\s+reset\b.*--hard\b/, 'git reset --hard는 기존 변경을 지웁니다.'],
  [/\bgit\s+clean\b.*\s-[a-zA-Z]*f/, 'git clean -f는 추적되지 않은 파일을 지웁니다.'],
  [/\bgit\s+stash\b(?!\s+(list|show)\b)/, '기존 변경을 stash로 숨기지 않습니다.'],
  [/\bgit\s+checkout\b.*(\s--\s|\s\.(\s|$)|\s-f\b)/, 'git checkout으로 작업 트리 변경을 버리지 않습니다.'],
  [/\bgit\s+restore\b(?!.*--staged)/, 'git restore로 작업 트리 변경을 버리지 않습니다.'],
];

// --env-file 인자로 경로만 넘기는 것은 허용하고, 내용을 출력·복사·편집하는 참조만 막는다.
const SECRET_FILE =
  /(?:^|[\s'"=/\\])(?<!--env-file(?:-if-exists)?[=\s])(?:\.env\.local|\.env\.test\.local|infra[/\\]\.env)(?=$|[\s'";|])/;

function decide(command) {
  const line = command.replace(/\s+/g, ' ');
  for (const [pattern, reason] of RULES) {
    if (pattern.test(line)) return reason;
  }
  if (SECRET_FILE.test(line)) return '환경파일(.env.local, .env.test.local, infra/.env)의 값은 읽거나 출력하지 않습니다.';
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
