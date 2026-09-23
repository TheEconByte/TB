import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

const createdEmails = new Set<string>();
const password = 'HarnessPass!2026';

async function signUp(page: Page, email: string, name: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill(name);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('heading', { name: /내 가정으로 확인하는 창업 재무계획/ })).toBeVisible();
}

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

test('가입부터 불변 결과 재조회와 다른 사용자 접근 차단까지 완료한다', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmail = `owner-${suffix}@example.test`;
  const otherEmail = `other-${suffix}@example.test`;
  const title = `하네스 검증 ${suffix}`;

  await page.goto('/');
  await signUp(page, ownerEmail, '하네스 소유자');

  await page.getByLabel('계획 제목').fill(title);
  await page.getByRole('button', { name: '저장하고 서버 계산' }).click();
  await expect(page.getByRole('heading', { name: /revision 1의 불변 결과/ })).toBeVisible();
  await expect(page.getByText('새 계산 결과를 저장했습니다.')).toBeVisible();

  const planId = await page.evaluate(async () => {
    const response = await fetch('/api/plans');
    const body = (await response.json()) as { plans: Array<{ id: string }> };
    return body.plans[0]?.id;
  });
  expect(planId).toBeTruthy();

  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: /revision 1의 불변 결과/ })).toBeVisible();

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  await page.getByLabel('이메일').fill(ownerEmail);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();

  await page.getByRole('button', { name: '로그아웃' }).click();
  await signUp(page, otherEmail, '다른 사용자');
  const otherUserStatus = await page.evaluate(async (id) => (await fetch(`/api/plans/${id}`)).status, planId);
  expect(otherUserStatus).toBe(404);
});
