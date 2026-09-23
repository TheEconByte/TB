import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

const password = 'HarnessPass!2026';
const createdEmails = new Set<string>();
const releaseIds = new Set<string>();

function pool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL이 없습니다.');
  return new Pool({ connectionString });
}

// 합성 공정위 가맹정보 릴리스. 커피·음료 브랜드 4개(현황이 모두 0인 1개 포함), 2개 기준년도, 창업 금액 포함.
async function seedFranchiseRelease(suffix: string): Promise<void> {
  const db = pool();
  const releaseId = `e2e-franchise-${suffix}`;
  releaseIds.add(releaseId);
  // [연도, 법인, 브랜드, 중분류, 가맹점, 신규, 종료, 해지, 명의, 평균매출(천원), 면적당(천원), 가맹금, 교육, 보증, 기타, 합계]
  const rows: Array<[number, string, string, string, number, number, number, number, number, ...(number | null)[]]> = [
    [2024, '메가(주)', 'MEGA 커피', '커피', 2681, 500, 30, 1, 90, 300000, 20000, 5500, 2200, 2000, 0, 9700],
    [2025, '메가(주)', 'MEGA 커피', '커피', 3325, 700, 40, 2, 110, 360000, 24000, 5500, 2200, 2000, 0, 9700],
    [2024, '(주)빽', '빽커피', '커피', 1449, 241, 20, 0, 108, 319087, 21360, null, null, null, null, null],
    [2025, '(주)빽', '빽커피', '커피', 1712, 286, 23, 0, 149, 324486, 20517, null, null, null, null, null],
    [2025, '새싹', '새싹음료', '음료 (커피 외)', 4, 2, 0, 0, 0, null, null, null, null, null, null, null],
    [2025, '준비', '준비중커피', '커피', 0, 0, 0, 0, 0, null, null, 3300, 0, 0, 0, 3300],
  ];
  try {
    await db.query(
      `INSERT INTO franchise_releases (id, "releaseKey", status, "schemaVersion", "sourceUrl", "basisYears",
        "retrievedAt", "startupCostsIncluded", "sourceTables", "validationSummary", "brandCount", "activatedAt", "updatedAt")
       VALUES ($1, $1, 'ACTIVE', 'ftc-franchise-v1.0.0', 'https://www.data.go.kr/data/15110241/openapi.do', '2024-2025',
        now(), true, '[]', '{}', $2, now() + interval '1 day', now())`,
      [releaseId, rows.length],
    );
    for (const [index, row] of rows.entries()) {
      await db.query(
        `INSERT INTO franchise_brand_stats (id, "releaseId", "disclosureYear", "corpName", "brandName", "industryLarge",
          "industryMiddle", "marketIndustryCode", "storeCount", "newStoreCount", "contractEndCount", "contractCancelCount",
          "ownershipChangeCount", "averageSalesThousand", "averageSalesPerAreaThousand", "franchiseFeeThousand",
          "educationFeeThousand", "depositThousand", "otherCostThousand", "startupTotalThousand")
         VALUES ($1, $2, $3, $4, $5, '외식', $6, 'CS100010', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [`${releaseId}-${index}`, releaseId, ...row],
      );
    }
  } finally {
    await db.end();
  }
}

async function signUp(page: Page, email: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill('프랜차이즈 확인');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('heading', { name: /내 가정으로 확인하는 창업 재무계획/ })).toBeVisible();
}

test.afterEach(async () => {
  const db = pool();
  try {
    if (createdEmails.size > 0)
      await db.query('DELETE FROM "user" WHERE email = ANY($1::text[])', [[...createdEmails]]);
    if (releaseIds.size > 0)
      await db.query('DELETE FROM franchise_releases WHERE id = ANY($1::text[])', [[...releaseIds]]);
  } finally {
    createdEmails.clear();
    releaseIds.clear();
    await db.end();
  }
});

test('업종에 맞는 공정위 가맹정보를 검색하고 브랜드 현황을 본다', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await seedFranchiseRelease(suffix);
  await page.goto('/');
  await signUp(page, `franchise-${suffix}@example.test`);

  const panel = page.getByRole('region', { name: '프랜차이즈 참고' });
  await expect(panel.getByText('사업 조건에서 업종을 고르면')).toBeVisible();
  await page.getByLabel('업종 대분류').selectOption('CS100010');

  // 가맹점 수 순서로 목록이 나오고 첫 브랜드가 선택된다. 금액은 천원 원본을 원으로 바꿔 보여 준다.
  await expect(panel.getByText('커피·음료 브랜드 4개 중 가맹점이 있는 곳 3개, 평균매출을 공개한 곳 2개')).toBeVisible();
  const rows = panel.locator('.franchise-list tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('MEGA 커피');
  const detail = panel.locator('.franchise-detail');
  await expect(detail.getByRole('heading', { name: /MEGA 커피/ })).toBeVisible();
  await expect(detail).toContainText('3,325개');
  await expect(detail).toContainText('전년 대비 +644개');
  await expect(detail).toContainText('360,000,000원');
  await expect(detail).toContainText('월 평균 약 30,000,000원');
  await expect(detail).toContainText('9,700,000원');

  // 창업 금액이 없는 브랜드는 0이 아니라 미기재로 보인다.
  await rows.nth(1).getByRole('button', { name: '빽커피' }).click();
  await expect(detail).toContainText('1,712개');
  await expect(detail).toContainText('324,486,000원');
  await expect(detail.locator('.reference-summary > div', { hasText: '창업 금액' })).toContainText('미기재');

  await rows.nth(2).getByRole('button', { name: '새싹음료' }).click();
  await expect(detail.locator('.reference-summary > div', { hasText: '연 평균매출' }).first()).toContainText('미기재');
  await expect(detail).toContainText('전년 자료 없음');

  // 가맹점 수·개폐점·평균매출이 모두 0인 브랜드는 0개로 확정하지 않는다.
  await expect(rows.nth(3)).toContainText('현황 없음');
  await rows.nth(3).getByRole('button', { name: '준비중커피' }).click();
  await expect(detail.locator('.reference-summary > div', { hasText: '가맹점 수' })).toContainText('현황 없음');
  await expect(detail).toContainText('2024년 가맹점·개폐점 현황이 없습니다(0 또는 미기재).');

  await panel.getByLabel('브랜드 검색').fill('mega');
  await expect(rows).toHaveCount(1);
  await expect(panel.getByText('검색 결과 1개')).toBeVisible();
  await panel.getByLabel('브랜드 검색').fill('없는브랜드');
  await expect(panel.getByText('‘없는브랜드’와 일치하는 커피·음료 브랜드가 없습니다.')).toBeVisible();
  await panel.getByLabel('브랜드 검색').fill('');
  await expect(rows).toHaveCount(4);

  await panel.screenshot({ path: testInfo.outputPath('franchise-panel.png') });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
