import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

const password = 'HarnessPass!2026';
const createdEmails = new Set<string>();
const marketReleaseIds = new Set<string>();
const scoreReleaseIds = new Set<string>();

function pool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL이 없습니다.');
  return new Pool({ connectionString });
}

const AREA_CODE = '3119801';
const GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'D'];
const gradeBoundaries = GRADES.map((grade, index) => ({ grade, minScore: [90, 80, 70, 60, 50, 40, 30, 0][index] }));

// 합성 상권 릴리스와 점수 릴리스. 상권 1곳(성동구), 한식만 점수를 내고 커피는 미지원이다.
async function seedScore(suffix: string): Promise<string> {
  const db = pool();
  const marketReleaseId = `e2e-market-${suffix}`;
  const scoreReleaseId = `e2e-score-${suffix}`;
  const scoreReleaseKey = `market-score-e2e-${suffix}`.toLowerCase();
  marketReleaseIds.add(marketReleaseId);
  scoreReleaseIds.add(scoreReleaseId);
  const industryModel = {
    industryCode: 'CS100001',
    industryName: '한식',
    intercept: -0.1,
    features: [
      {
        key: 'salesPerStore',
        label: '점포당 매출',
        definition: 'log(t−3~t 매출 합 ÷ t−3~t 평균 점포 수)',
        expectedScoreDirection: 1,
        beta: -0.3,
        standardError: 0.02,
        pValue: 0.0001,
        mean: 18.9,
        std: 0.8,
      },
      {
        key: 'storeCount',
        label: '동일 업종 점포 수',
        definition: 'log(t 점포 수)',
        expectedScoreDirection: 0,
        beta: 0.2,
        standardError: 0.02,
        pValue: 0.0001,
        mean: 3.1,
        std: 0.9,
      },
    ],
    trainQuarters: ['20221', '20242'],
    testQuarters: ['20243', '20252'],
    trainSize: 1000,
    testSize: 400,
    trainPositiveRate: 0.5,
    testPositiveRate: 0.5,
    trainAuc: 0.63,
    testAuc: 0.62,
    zClip: 3,
  };
  const model = {
    version: 'market-score-e2e',
    definitionVersion: 'market-score-def-e2e',
    createdAt: '2026-10-31T00:00:00.000Z',
    marketReleaseKey: marketReleaseId,
    dataPeriod: { start: '20211', end: '20262' },
    minStoreCount: 5,
    gradeBoundaries,
    industries: [
      industryModel,
      { ...industryModel, industryCode: 'CS100010', industryName: '커피·음료', testAuc: 0.55 },
    ],
  };
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i * 10,
    to: i === 9 ? 100 : i * 10 + 9,
    count: i === 7 ? 1 : 0,
  }));
  const exclusions = {
    NO_DATA: 0,
    FEW_STORES: 0,
    NO_SALES: 0,
    NO_PRIOR_SALES: 0,
    INCOMPLETE_WINDOW: 0,
    FEATURE_UNAVAILABLE: 0,
  };
  const summary = {
    baseQuarter: '20262',
    minTestAuc: 0.6,
    servedIndustryCodes: ['CS100001'],
    industries: [
      {
        industryCode: 'CS100001',
        industryName: '한식',
        served: true,
        testAuc: 0.62,
        scoredCount: 1,
        bins,
        gradeCounts: Object.fromEntries(GRADES.map((grade) => [grade, grade === 'A' ? 1 : 0])),
        featureAverages: { salesPerStore: '2000000', storeCount: '12' },
        monthlyRevenueWarningRange: { low: '500000', high: '9000000' },
        exclusions,
      },
      {
        industryCode: 'CS100010',
        industryName: '커피·음료',
        served: false,
        testAuc: 0.55,
        scoredCount: 0,
        bins: bins.map((bin) => ({ ...bin, count: 0 })),
        gradeCounts: Object.fromEntries(GRADES.map((grade) => [grade, 0])),
        featureAverages: {},
        monthlyRevenueWarningRange: null,
        exclusions,
      },
    ],
  };
  const detail = {
    features: [
      {
        key: 'salesPerStore',
        label: '점포당 매출',
        displayLabel: '점포당 월매출(잠정)',
        unit: 'WON',
        displayValue: '3000000',
        value: 16.3,
        z: 1.2,
        contribution: 0.36,
      },
      {
        key: 'storeCount',
        label: '동일 업종 점포 수',
        displayLabel: '점포 수',
        unit: 'COUNT',
        displayValue: '8',
        value: 2.08,
        z: -1.1,
        contribution: 0.22,
      },
    ],
    monthlyRevenueBasis: { quarters: ['20253', '20254', '20261', '20262'], salesSum: '96000000', storeCountSum: 32 },
  };
  try {
    // 활성화 시각을 미래로 두어 기존 ACTIVE보다 먼저 조회되게 한다.
    await db.query(
      `INSERT INTO market_releases (id, "releaseKey", label, status, "schemaVersion", "definitionVersion", "sourceUrl",
        "basisPeriod", "basisPeriodLabel", "retrievedAt", files, "validationSummary", "areaCount", "quarterlyRowCount",
        "activatedAt", "updatedAt")
       VALUES ($1, $1, 'E2E 상권', 'ACTIVE', 'e2e', 'e2e', 'https://data.seoul.go.kr/', '20211-20262',
        '2021년 1분기~2026년 2분기', now(), '[]', '{}', 1, 0, now() + interval '1 day', now())`,
      [marketReleaseId],
    );
    for (const [code, name] of [
      ['CS100001', '한식'],
      ['CS100010', '커피·음료'],
    ]) {
      await db.query(
        `INSERT INTO industries ("releaseId", code, "sourceName", "displayName", "displayNameSource",
          "sourceCategoryVersion", "isSupported", "updatedAt")
         VALUES ($1, $2, $3, $3, 'PRODUCT_DOCUMENT', 'e2e', true, now())`,
        [marketReleaseId, code, name],
      );
    }
    await db.query(
      `INSERT INTO market_areas (id, "releaseId", "areaType", "areaCode", "sourceName", "areaTypeName",
        "districtCode", "districtName")
       VALUES ($1, $2, 'A', $3, 'E2E 상권', '골목상권', '11200', '성동구')`,
      [`${marketReleaseId}-area`, marketReleaseId, AREA_CODE],
    );
    await db.query(
      `INSERT INTO market_score_releases (id, "releaseKey", status, "modelVersion", "modelChecksum", "modelJson",
        "marketReleaseId", "marketReleaseKey", "baseQuarter", "summaryJson", "activatedAt", "updatedAt")
       VALUES ($1, $2, 'ACTIVE', 'market-score-e2e', 'e2e', $3, $4, $4, '20262', $5, now() + interval '1 day', now())`,
      [scoreReleaseId, scoreReleaseKey, JSON.stringify(model), marketReleaseId, JSON.stringify(summary)],
    );
    await db.query(
      `INSERT INTO market_scores (id, "releaseId", "industryCode", "areaType", "areaCode", status, "storeCount", score,
        grade, probability, rank, "monthlyRevenueDefault", "detailJson")
       VALUES ($1, $2, 'CS100001', 'A', $3, 'SCORED', 8, 72, 'A', 0.28, 1, 3000000, $4)`,
      [`${scoreReleaseId}-row`, scoreReleaseId, AREA_CODE, JSON.stringify(detail)],
    );
  } finally {
    await db.end();
  }
  return scoreReleaseKey;
}

async function signUp(page: Page, email: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill('상권 점수 확인');
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
    if (scoreReleaseIds.size > 0)
      await db.query('DELETE FROM market_score_releases WHERE id = ANY($1::text[])', [[...scoreReleaseIds]]);
    if (marketReleaseIds.size > 0)
      await db.query('DELETE FROM market_releases WHERE id = ANY($1::text[])', [[...marketReleaseIds]]);
  } finally {
    createdEmails.clear();
    scoreReleaseIds.clear();
    marketReleaseIds.clear();
    await db.end();
  }
});

test('상권 점수에서 재무 계획을 시작하고 저장 당시 등급을 다시 본다', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const releaseKey = await seedScore(suffix);

  await page.goto('/markets');
  await page.getByLabel('1. 자치구').selectOption('11200');
  await page.getByLabel('2. 상권').selectOption(`A:${AREA_CODE}`);
  await page.getByLabel('3. 업종').selectOption('CS100001');

  const panel = page.locator('.score-panel');
  await expect(panel.getByRole('heading', { name: 'E2E 상권 · 한식' })).toBeVisible();
  await expect(panel.getByLabel('점수 72점, 등급 A')).toBeVisible();
  await expect(panel.getByText('서울 한식 상권 1곳 중 상위 100%')).toBeVisible();
  await expect(panel.getByText(/개별 점포의 생존 확률이 아닙니다/)).toBeVisible();
  await expect(panel.getByText('점포당 매출: 업종 평균보다 높음 → 점수 올림')).toBeVisible();
  await expect(panel.getByText('동일 업종 점포 수: 업종 평균보다 낮음 → 점수 올림')).toBeVisible();
  await expect(panel.locator('details.score-basis')).not.toHaveAttribute('open', '');

  // 커피는 테스트 AUC 기준 미달이라 미지원 업종이다.
  await page.getByLabel('3. 업종').selectOption('CS100010');
  await expect(page.locator('.score-panel').getByText('현재 한식만 지원합니다.')).toBeVisible();
  await page.getByLabel('3. 업종').selectOption('CS100001');
  await expect(panel.getByLabel('점수 72점, 등급 A')).toBeVisible();

  await panel.getByRole('link', { name: '이 상권으로 재무 계획 시작' }).click();
  await expect(page).toHaveURL(/scoreArea=3119801/);
  await signUp(page, `market-score-${suffix}@example.test`);

  const source = page.getByTestId('market-source');
  await expect(source).toContainText('E2E 상권 한식 점포당 평균 기준 · 등급 A');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('3,000,000');
  await expect(page.getByLabel('계획 제목')).toHaveValue('E2E 상권 한식 계획');
  await expect(page.getByLabel('2. 사업장·거주 자치구')).toHaveValue('11200');

  // 사용자가 고친 월매출은 재무 입력에, 상권 기본값은 스냅샷에 따로 남는다.
  await page.locator('#monthlyRevenue').fill('2500000');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();
  await expect(page).not.toHaveURL(/scoreArea=/);

  await page.reload();
  await page.getByRole('button', { name: /E2E 상권 한식 계획/ }).click();
  await expect(source).toContainText('등급 A');
  await expect(source).toContainText('계획을 만들 때 저장한 값입니다');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('2,500,000');

  const stored = await page.evaluate(async () => {
    const list = (await (await fetch('/api/plans')).json()) as { plans: Array<{ id: string }> };
    const detail = await (await fetch(`/api/plans/${list.plans[0].id}`)).json();
    return detail.plan as { marketScoreJson: Record<string, unknown>; inputJson: { monthlyRevenue: string } };
  });
  expect(stored.marketScoreJson).toMatchObject({
    releaseKey,
    grade: 'A',
    score: 72,
    areaCode: AREA_CODE,
    monthlyRevenueDefault: '3000000',
  });
  expect(stored.inputJson.monthlyRevenue).toBe('2500000');

  await page.goto(`/funding?scoreAreaType=A&scoreArea=${AREA_CODE}&scoreIndustry=CS100001&scoreRelease=${releaseKey}`);
  await expect(page.getByTestId('funding-grade')).toContainText('상권 생존점수 등급 A (72점)');
  await expect(page.getByTestId('funding-grade')).toContainText('자금 후보 판정 조건에 쓰지 않으며');
});
