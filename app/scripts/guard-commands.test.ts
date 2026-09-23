import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// .claude/hooks/guard-commands.mjs를 Claude Code와 같은 방식(stdin JSON)으로 실행해 판정만 확인한다.
const HOOK = fileURLToPath(new URL('../../.claude/hooks/guard-commands.mjs', import.meta.url));

function decision(command: string): 'deny' | 'allow' {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`hook 실행 실패: ${result.stderr}`);
  return result.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
}

describe('가드 hook', () => {
  it.each([
    'npx prisma migrate reset --force',
    'docker compose --env-file infra/.env -f infra/compose.yaml down -v',
    'docker volume rm trendbench-mvp_mvp_postgres_data',
    'docker system prune -a --volumes',
    'git push --force origin main',
    'git push --force-with-lease',
    'git push origin +main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean --force -d',
    'git stash',
    'git stash push -m wip',
    'git checkout -- docs/PRODUCT.md',
    'git checkout HEAD -- docs/PRODUCT.md',
    'git checkout .',
    'git checkout -f main',
    'git switch -f main',
    'git switch --discard-changes main',
    'git restore docs/PRODUCT.md',
    'git restore --staged --worktree docs/PRODUCT.md',
    'rm -rf data/raw',
    'Remove-Item -Recurse -Force data\\raw',
    'cat app/.env.local',
    'Get-Content app\\.env.local',
    'type app\\.env.test.local',
    'cat infra/.env',
    'cat app/.env',
    'cp app/.env.local /tmp/copy',
    'Test-Path app/.env.local; cat app/.env.local',
  ])('막는다: %s', (command) => {
    expect(decision(command)).toBe('deny');
  });

  it.each([
    'git status --short',
    'git checkout -b feat/12-result-compare origin/main',
    'git switch main',
    'git stash list',
    'git restore --staged docs/PRODUCT.md',
    'git push origin feat/12-result-compare',
    'git clean -n',
    'docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait',
    'docker compose --env-file infra/.env -f infra/compose.yaml stop',
    'cat app/.env.example',
    'cat infra/.env.example',
    'Test-Path app/.env.local',
    'test -f app/.env.test.local',
    'ls data/raw',
    'npm --prefix app run business:load',
    'node --env-file-if-exists=.env.local scripts/load-market.ts',
  ])('허용한다: %s', (command) => {
    expect(decision(command)).toBe('allow');
  });
});
