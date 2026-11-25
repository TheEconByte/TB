import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

// 공개 홈(/)은 서비스의 중심 화면이다. 로그인 전에도 상권 → 재무 계획 → 자금 공고 흐름과 각 화면으로 가는 길을
// 보여 주고, 로그인하면 내 최근 계획과 마지막 저장 결과에서 이어 갈 수 있게 한다. 재무 계획 작업 화면은 /plans다.

const createdEmails = new Set<string>();
const password = 'HarnessPass!2026';

async function signUp(page: Page, email: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill('홈 확인');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '재무 계획', exact: true })).toBeVisible();
}

const uniqueSuffix = (projectName: string) => `${projectName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.afterEach(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || createdEmails.size === 0) return;
  const pool = new Pool({ connectionString });
  try {
    await pool.query('DELETE FROM "user" WHERE email = ANY($1::text[])', [[...createdEmails]]);
  } finally {
    createdEmails.clear();
    await pool.end();
  }
});

test('로그인 전 홈은 로그인 폼이 아니라 준비 순서와 각 화면으로 가는 길을 보여 준다', async ({ page }) => {
  await page.goto('/');
  // 홈이 로그인 벽이면 로그인 없이 쓰는 상권 탐색에 닿기 어렵다.
  await expect(page.getByLabel('비밀번호')).toHaveCount(0);

  const steps = page.getByRole('region', { name: '화면 안내' });
  await expect(steps.getByRole('heading', { level: 2 })).toHaveText(['상권', '재무 계획', '자금 공고']);
  await expect(steps.getByRole('link', { name: '상권 보기' })).toHaveAttribute('href', '/markets');
  await expect(steps.getByRole('link', { name: '계획 열기' })).toHaveAttribute('href', '/plans');
  await expect(steps.getByRole('link', { name: '공고 보기' })).toHaveAttribute('href', '/funding');

  await page.getByRole('link', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
});

test('세 화면이 같은 머리말을 쓰고 지금 화면을 표시한다', async ({ page }) => {
  for (const [path, current] of [
    ['/markets', '상권'],
    ['/plans', '재무 계획'],
    ['/funding', '자금 공고'],
  ] as const) {
    await page.goto(path);
    const nav = page.locator('header').getByRole('navigation', { name: '주요 화면' });
    await expect(nav.getByRole('link')).toHaveText(['상권', '재무 계획', '자금 공고']);
    await expect(nav.getByRole('link', { name: current, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('header').getByRole('link', { name: /TrendBench/ })).toHaveAttribute('href', '/');
  }
});

test('로그인한 홈은 최근 계획과 마지막 저장 결과를 보여 주고 그 계획으로 이어 준다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const calculated = `홈 계산한 계획 ${suffix}`;
  const draft = `홈 초안 ${suffix}`;

  await page.goto('/plans');
  await signUp(page, `home-${suffix}@example.test`);

  await page.getByLabel('계획 제목').fill(calculated);
  await page.getByRole('button', { name: '저장하고 계산' }).click();
  await expect(page.getByRole('heading', { name: '계산 결과 · 1번째 저장 기준' })).toBeVisible();
  // 홈 요약은 계획 화면의 저장 결과와 같은 값이어야 한다. 홈이 따로 계산하거나 다른 값을 보이면 안 된다.
  const gap = await page.locator('.summary-grid > div', { hasText: '계획상 부족자금' }).locator('strong').innerText();

  await page.getByRole('button', { name: '새 계획' }).click();
  await page.getByLabel('계획 제목').fill(draft);
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();

  await page
    .locator('header')
    .getByRole('link', { name: /TrendBench/ })
    .click();
  await expect(page).toHaveURL(/\/$/);
  const recent = page.getByRole('region', { name: '내 계획' });
  // 최근에 고친 계획이 먼저 온다.
  await expect(recent.getByRole('listitem').nth(0)).toContainText(draft);
  await expect(recent.getByRole('listitem').nth(1)).toContainText(calculated);
  // 계산하지 않은 계획에 숫자를 지어내지 않는다.
  await expect(recent.getByRole('listitem').nth(0)).toContainText('아직 계산 전입니다');

  const calculatedItem = recent.getByRole('listitem').nth(1);
  await expect(calculatedItem).toContainText('1번째 저장 기준 계산 결과');
  await expect(calculatedItem.locator('dl > div', { hasText: '계획상 부족자금' }).locator('dd')).toHaveText(gap);

  await expect(calculatedItem.getByRole('link', { name: '열기', exact: true })).toHaveAttribute(
    'href',
    /^\/plans\?plan=/,
  );
  await calculatedItem.getByRole('link', { name: '열기', exact: true }).click();
  await expect(page.getByLabel('계획 제목')).toHaveValue(calculated);
  await expect(page.getByRole('heading', { name: '계산 결과 · 1번째 저장 기준' })).toBeVisible();
  // 연 계획 주소를 남기지 않는다. 새로고침하면 목록에서 다시 고른다.
  await expect(page).toHaveURL(/\/plans$/);
});

test('주소의 계획이 없거나 남의 계획이면 열지 않고 새 계획으로 둔다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  await page.goto('/plans?plan=does-not-exist');
  await signUp(page, `home-missing-${suffix}@example.test`);
  await expect(page.locator('.status-message')).toBeVisible();
  await expect(page.getByLabel('계획 제목')).toHaveValue('');
  await expect(page).toHaveURL(/\/plans$/);
});
