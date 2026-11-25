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
  await expect(page.getByRole('heading', { level: 1, name: '재무 계획', exact: true })).toBeVisible();
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

  await page.goto('/plans');
  await signUp(page, ownerEmail, '하네스 소유자');

  await page.getByLabel('계획 제목').fill(title);
  // 계산은 마지막 입력 단계(자금 마련)의 [계산하고 결과 보기]로 한다.
  await page
    .getByRole('navigation', { name: '계획 단계' })
    .getByRole('button', { name: /^자금 마련/ })
    .click();
  await page.getByRole('button', { name: '계산하고 결과 보기' }).click();
  await expect(page.getByRole('region', { name: '계산 결과' })).toContainText('1번째 저장한 입력으로 계산했습니다.');
  await expect(page.getByText('계산 결과를 저장했습니다.')).toBeVisible();
  // 계획 목록의 계산 횟수는 새로고침하지 않아도 방금 저장한 결과를 센다(2026-11-25 화면 점검에서 0회로 남았다).
  await expect(page.getByRole('button', { name: new RegExp(title) })).toContainText('계산 1회');

  const planId = await page.evaluate(async () => {
    const response = await fetch('/api/plans');
    const body = (await response.json()) as { plans: Array<{ id: string }> };
    return body.plans[0]?.id;
  });
  expect(planId).toBeTruthy();

  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('region', { name: '계산 결과' })).toContainText('1번째 저장한 입력으로 계산했습니다.');

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

// 사업 조건 입력 단계는 재무 계획 안에 있다. 새 계획을 처음 저장해도 보던 단계와 입력이 그대로여야 하고,
// 다른 계획을 열면 재무 입력은 그 계획 값으로 바뀌어야 한다.
test('처음 저장해도 사업 조건 단계가 그대로이고, 다른 계획을 열면 입력이 바뀐다', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/plans');
  await signUp(page, `layout-${suffix}@example.test`, '화면 배치 확인');

  const wizard = page.locator('.business-wizard');
  await wizard.getByRole('button', { name: /매장 층/ }).click();
  await expect(wizard.getByRole('button', { name: /매장 층/ })).toHaveAttribute('aria-current', 'step');

  await page.getByLabel('계획 제목').fill(`첫 계획 ${suffix}`);
  await page
    .getByRole('navigation', { name: '계획 단계' })
    .getByRole('button', { name: /^월 운영/ })
    .click();
  await page.locator('#monthlyRevenue').fill('15000000');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();
  // 다른 단계에 있다가 돌아와도 사업 조건 입력 단계는 보던 곳 그대로다.
  await page.getByRole('navigation', { name: '계획 단계' }).getByRole('button', { name: /^매장/ }).click();
  await expect(wizard.getByRole('button', { name: /매장 층/ })).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('15,000,000');

  await page.getByRole('button', { name: '새 계획' }).click();
  await page.getByLabel('계획 제목').fill(`둘째 계획 ${suffix}`);
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();
  // 새 계획은 빈 입력에서 시작한다. 예시 금액을 채우지 않는다(finance/form.ts).
  await expect(page.locator('#monthlyRevenue')).toHaveValue('');

  await page.getByRole('button', { name: new RegExp(`첫 계획 ${suffix}`) }).click();
  await expect(page.getByLabel('계획 제목')).toHaveValue(`첫 계획 ${suffix}`);
  await expect(page.locator('#monthlyRevenue')).toHaveValue('15,000,000');
});

// 대출 가정 적용 기능은 ADR 0009 §5로 없앴다. 그 전에 저장된 출처는 계획 화면과 저장 결과에서 그대로 보여야 한다
// (ADR 0009 Validation의 호환성). 없앤 API가 쓰던 모양 그대로 DB에 넣고 화면에서 읽는다.
test('없앤 적용 기능이 저장한 대출 가정 출처를 계획과 결과에서 그대로 보여 준다', async ({ page }, testInfo) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL이 없습니다.');
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `대출 가정 출처 ${suffix}`;

  await page.goto('/plans');
  await signUp(page, `loan-assumption-${suffix}@example.test`, '대출 가정 확인');
  await page.getByLabel('계획 제목').fill(title);
  // 계산은 마지막 입력 단계(자금 마련)의 [계산하고 결과 보기]로 한다.
  await page
    .getByRole('navigation', { name: '계획 단계' })
    .getByRole('button', { name: /^자금 마련/ })
    .click();
  await page.getByRole('button', { name: '계산하고 결과 보기' }).click();
  await expect(page.getByRole('region', { name: '계산 결과' })).toContainText('1번째 저장한 입력으로 계산했습니다.');
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
  await expect(page.getByRole('region', { name: '계산 결과' })).toContainText('1번째 저장한 입력으로 계산했습니다.');
  // 계산한 계획은 결과 단계로 열린다. 대출 가정 출처는 자금 공고 단계에 있다.
  await page
    .getByRole('navigation', { name: '계획 단계' })
    .getByRole('button', { name: /^자금 공고/ })
    .click();
  const planSource = page.getByText(/^저장된 대출 가정 출처:/);
  await expect(planSource).toContainText('e2e-loan@1.0.0');
  await expect(planSource).toContainText('승인 확정이 아니며');
  await page.getByRole('navigation', { name: '계획 단계' }).getByRole('button', { name: /^결과/ }).click();
  const resultSource = page.getByText(/^이 결과에 쓴 대출 가정:/);
  await expect(resultSource).toContainText('e2e-catalog@2026-09-20.1');
});
