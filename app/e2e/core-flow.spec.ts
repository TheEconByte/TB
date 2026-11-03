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

// 대출 가정 적용 기능은 ADR 0009 §5로 없앴다. 그 전에 저장된 출처는 계획 화면과 저장 결과에서 그대로 보여야 한다
// (ADR 0009 Validation의 호환성). 없앤 API가 쓰던 모양 그대로 DB에 넣고 화면에서 읽는다.
test('없앤 적용 기능이 저장한 대출 가정 출처를 계획과 결과에서 그대로 보여 준다', async ({ page }, testInfo) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL이 없습니다.');
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `대출 가정 출처 ${suffix}`;

  await page.goto('/');
  await signUp(page, `loan-assumption-${suffix}@example.test`, '대출 가정 확인');
  await page.getByLabel('계획 제목').fill(title);
  await page.getByRole('button', { name: '저장하고 서버 계산' }).click();
  await expect(page.getByRole('heading', { name: /revision 1의 불변 결과/ })).toBeVisible();
  const planId = await page.evaluate(async () => {
    const body = (await (await fetch('/api/plans')).json()) as { plans: Array<{ id: string }> };
    return body.plans[0]?.id;
  });
  expect(planId).toBeTruthy();

  const stored = {
    productKey: 'e2e-loan',
    version: '1.0.0',
    name: 'E2E 대출 상품',
    catalogKey: 'e2e-catalog',
    catalogVersion: '2026-09-20.1',
    appliedAt: '2026-09-21T00:00:00.000Z',
    newLoan: {
      principal: '10000000',
      annualInterestRatePercent: '3',
      totalMonths: 60,
      graceMonths: 0,
      repaymentMethod: 'EQUAL_PAYMENT',
    },
  };
  const pool = new Pool({ connectionString });
  try {
    await pool.query('UPDATE plans SET "loanAssumptionJson" = $1::jsonb WHERE id = $2', [
      JSON.stringify(stored),
      planId,
    ]);
    await pool.query('UPDATE plan_results SET "loanAssumptionJson" = $1::jsonb WHERE "planId" = $2', [
      JSON.stringify(stored),
      planId,
    ]);
  } finally {
    await pool.end();
  }

  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: /revision 1의 불변 결과/ })).toBeVisible();
  const planSource = page.getByText(/^저장된 대출 가정 출처:/);
  await expect(planSource).toContainText('e2e-loan@1.0.0');
  await expect(planSource).toContainText('승인 확정이 아니며');
  const resultSource = page.getByText(/^저장 결과에 반영된 대출 가정:/);
  await expect(resultSource).toContainText('e2e-catalog@2026-09-20.1');
});
