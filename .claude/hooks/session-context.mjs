// SessionStart hook. AGENTS.md "시작 전에 반드시 할 일" 1~2단계의 사실을 세션 문맥에 넣는다.
import { execFileSync } from 'node:child_process';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '(확인 실패)';
  }
}

const MAX_LINES = 40;
const lines = git(['status', '--short', '--branch']).split('\n');
const status =
  lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES), `… 외 ${lines.length - MAX_LINES}개 (git status --short로 전체 확인)`].join('\n')
    : lines.join('\n');
const head = git(['log', '-1', '--format=%h %s']);

process.stdout.write(
  [
    '[TrendBench 세션 시작 상태]',
    `HEAD: ${head}`,
    status,
    '',
    '위 변경은 사용자·다른 작업자의 소유다. 덮어쓰기·stash·reset·checkout으로 정리하지 않는다.',
    '작업 계약(GitHub Issue)이 없으면 조사와 제안까지만 한다. 기준: AGENTS.md → docs/PROJECT_CONTEXT.md.',
  ].join('\n') + '\n',
);
