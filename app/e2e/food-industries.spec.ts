import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

// ADR 0010으로 연 새 요식업 업종의 상권 화면. 점수 없이 여는 업종(중식)과 AUC 기준을 넘어 점수를 내는 업종
// (패스트푸드)을 함께 본다. 한식·커피 경로는 market-score.spec.ts에 있다.

const password = 'HarnessPass!2026';
const createdEmails = new Set<string>();
const marketReleaseIds = new Set<string>();
const scoreReleaseIds = new Set<string>();

function pool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL이 없습니다.');
  return new Pool({ connectionString });
}

const AREA_CODE = '3119802';
const CHINESE = 'CS100002';
const FAST_FOOD = 'CS100006';
const GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'D'];
const gradeBoundaries = GRADES.map((grade, index) => ({ grade, minScore: [90, 80, 70, 60, 50, 40, 30, 0][index] }));

// 서울시 외식업 상위 업종 열 개(ADR 0010 "확인한 사실")와 화면 표시명. 열 개 모두 열려 있다(ADR 0010 7단계).
const FOOD_INDUSTRIES = [
  ['CS100001', '한식음식점', '한식'],
  ['CS100002', '중식음식점', '중식'],
  ['CS100003', '일식음식점', '일식'],
  ['CS100004', '양식음식점', '양식'],
  ['CS100005', '제과점', '제과점'],
  ['CS100006', '패스트푸드점', '패스트푸드'],
  ['CS100007', '치킨전문점', '치킨'],
  ['CS100008', '분식전문점', '분식'],
  ['CS100009', '호프-간이주점', '호프·간이주점'],
  ['CS100010', '커피-음료', '커피·음료'],
] as const;

// 중식은 2026년 2분기 매출 원값이 없다. 없는 값은 0이 아니라 자료 부족이어야 한다(AGENTS.md §3-2).
const QUARTERLY = [
  { industryCode: CHINESE, quarter: '20261', salesAmount: '45000000', salesCount: '3100', storeCount: 6 },
  { industryCode: CHINESE, quarter: '20262', salesAmount: null, salesCount: null, storeCount: 7 },
  { industryCode: FAST_FOOD, quarter: '20261', salesAmount: '52000000', salesCount: '6400', storeCount: 5 },
  { industryCode: FAST_FOOD, quarter: '20262', salesAmount: '56000000', salesCount: '6900', storeCount: 6 },
];

// 합성 상권 릴리스와 점수 릴리스. 상권 1곳(성동구). 점수 모델은 세 업종을 학습했고, 중식은 테스트 AUC가
// 기준(0.6) 미만이라 미지원이다(ADR 0008). 점수 행은 패스트푸드에만 넣는다.
async function seed(suffix: string): Promise<string> {
  const db = pool();
  const marketReleaseId = `e2e-food-market-${suffix}`;
  const scoreReleaseId = `e2e-food-score-${suffix}`;
  const scoreReleaseKey = `market-score-e2e-food-${suffix}`.toLowerCase();
  marketReleaseIds.add(marketReleaseId);
  scoreReleaseIds.add(scoreReleaseId);
  const industryModel = (industryCode: string, industryName: string, testAuc: number) => ({
    industryCode,
    industryName,
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
    ],
    trainQuarters: ['20221', '20242'],
    testQuarters: ['20243', '20252'],
    trainSize: 1000,
    testSize: 400,
    trainPositiveRate: 0.5,
    testPositiveRate: 0.5,
    trainAuc: 0.63,
    testAuc,
    zClip: 3,
  });
  const model = {
    version: 'market-score-e2e-food',
    definitionVersion: 'market-score-def-e2e',
    createdAt: '2026-11-25T00:00:00.000Z',
    marketReleaseKey: marketReleaseId,
    dataPeriod: { start: '20211', end: '20262' },
    minStoreCount: 5,
    gradeBoundaries,
    industries: [
      industryModel('CS100001', '한식', 0.62),
      industryModel(CHINESE, '중식', 0.55),
      industryModel(FAST_FOOD, '패스트푸드', 0.61),
    ],
  };
  const bins = (scored: boolean) =>
    Array.from({ length: 10 }, (_, i) => ({
      from: i * 10,
      to: i === 9 ? 100 : i * 10 + 9,
      count: scored && i === 6 ? 1 : 0,
    }));
  const exclusions = {
    NO_DATA: 0,
    FEW_STORES: 0,
    NO_SALES: 0,
    NO_PRIOR_SALES: 0,
    INCOMPLETE_WINDOW: 0,
    FEATURE_UNAVAILABLE: 0,
  };
  const servedSummary = (industryCode: string, industryName: string, testAuc: number) => ({
    industryCode,
    industryName,
    served: true,
    testAuc,
    scoredCount: 1,
    bins: bins(true),
    gradeCounts: Object.fromEntries(GRADES.map((grade) => [grade, grade === 'BBB' ? 1 : 0])),
    featureAverages: { salesPerStore: '2000000' },
    monthlyRevenueWarningRange: { low: '500000', high: '9000000' },
    exclusions,
  });
  const summary = {
    baseQuarter: '20262',
    monthlyRevenueInterpretation: 'QUARTER_TOTAL',
    minTestAuc: 0.6,
    servedIndustryCodes: ['CS100001', FAST_FOOD],
    industries: [
      servedSummary('CS100001', '한식', 0.62),
      {
        industryCode: CHINESE,
        industryName: '중식',
        served: false,
        testAuc: 0.55,
        scoredCount: 0,
        bins: bins(false),
        gradeCounts: Object.fromEntries(GRADES.map((grade) => [grade, 0])),
        featureAverages: {},
        monthlyRevenueWarningRange: null,
        exclusions,
      },
      servedSummary(FAST_FOOD, '패스트푸드', 0.61),
    ],
  };
  // 월매출 기본값은 최근 4분기 매출 원값 합 ÷ (점포 수 합 × 3)이다(ADR 0011): 180,000,000 ÷ (25 × 3) = 2,400,000.
  const detail = {
    features: [
      {
        key: 'salesPerStore',
        label: '점포당 매출',
        displayLabel: '점포당 월매출(잠정)',
        unit: 'WON',
        displayValue: '2400000',
        value: 15.8,
        z: 0.6,
        contribution: 0.18,
      },
    ],
    monthlyRevenueBasis: { quarters: ['20253', '20254', '20261', '20262'], salesSum: '180000000', storeCountSum: 25 },
  };
  try {
    // 활성화 시각을 미래로 두어 기존 ACTIVE보다 먼저 조회되게 한다.
    await db.query(
      `INSERT INTO market_releases (id, "releaseKey", label, status, "schemaVersion", "definitionVersion", "sourceUrl",
        "basisPeriod", "basisPeriodLabel", "retrievedAt", files, "validationSummary", "areaCount", "quarterlyRowCount",
        "activatedAt", "updatedAt")
       VALUES ($1, $1, 'E2E 요식업 상권', 'ACTIVE', 'e2e', 'e2e', 'https://data.seoul.go.kr/', '20261-20262',
        '2026년 1분기~2026년 2분기', now(), '[]', '{}', 1, $2, now() + interval '1 day', now())`,
      [marketReleaseId, QUARTERLY.length],
    );
    for (const [code, sourceName, displayName] of FOOD_INDUSTRIES) {
      await db.query(
        `INSERT INTO industries ("releaseId", code, "sourceName", "displayName", "displayNameSource",
          "sourceCategoryVersion", "isSupported", "updatedAt")
         VALUES ($1, $2, $3, $4, 'PRODUCT_DOCUMENT', 'e2e', true, now())`,
        [marketReleaseId, code, sourceName, displayName],
      );
    }
    await db.query(
      `INSERT INTO market_areas (id, "releaseId", "areaType", "areaCode", "sourceName", "areaTypeName",
        "districtCode", "districtName")
       VALUES ($1, $2, 'A', $3, 'E2E 요식업 상권', '골목상권', '11200', '성동구')`,
      [`${marketReleaseId}-area`, marketReleaseId, AREA_CODE],
    );
    for (const row of QUARTERLY) {
      await db.query(
        `INSERT INTO market_quarterly (id, "releaseId", quarter, "areaType", "areaCode", "industryCode", "salesAmount",
          "salesCount", "storeCount")
         VALUES ($1, $2, $3, 'A', $4, $5, $6, $7, $8)`,
        [
          `${marketReleaseId}-${row.industryCode}-${row.quarter}`,
          marketReleaseId,
          row.quarter,
          AREA_CODE,
          row.industryCode,
          row.salesAmount,
          row.salesCount,
          row.storeCount,
        ],
      );
    }
    await db.query(
      `INSERT INTO market_score_releases (id, "releaseKey", status, "modelVersion", "modelChecksum", "modelJson",
        "marketReleaseId", "marketReleaseKey", "baseQuarter", "summaryJson", "activatedAt", "updatedAt")
       VALUES ($1, $2, 'ACTIVE', 'market-score-e2e-food', 'e2e', $3, $4, $4, '20262', $5, now() + interval '1 day', now())`,
      [scoreReleaseId, scoreReleaseKey, JSON.stringify(model), marketReleaseId, JSON.stringify(summary)],
    );
    await db.query(
      `INSERT INTO market_scores (id, "releaseId", "industryCode", "areaType", "areaCode", status, "storeCount", score,
        grade, probability, rank, "monthlyRevenueDefault", "detailJson")
       VALUES ($1, $2, $3, 'A', $4, 'SCORED', 6, 64, 'BBB', 0.36, 1, 2400000, $5)`,
      [`${scoreReleaseId}-row`, scoreReleaseId, FAST_FOOD, AREA_CODE, JSON.stringify(detail)],
    );
  } finally {
    await db.end();
  }
  return scoreReleaseKey;
}

async function signUp(page: Page, email: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill('새 업종 확인');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 계획', exact: true })).toBeVisible();
}

function startUrl(industryCode: string, releaseKey: string): string {
  return `/?scoreAreaType=A&scoreArea=${AREA_CODE}&scoreIndustry=${industryCode}&scoreRelease=${releaseKey}`;
}

function uniqueSuffix(projectName: string): string {
  return `${projectName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function responseFor(page: Page, path: string, industryCode: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === path && url.searchParams.get('industryCode') === industryCode;
  });
}

async function openArea(page: Page): Promise<void> {
  await page.goto('/markets');
  await page.getByLabel('1. 자치구').selectOption('11200');
  await page.getByLabel('2. 상권').selectOption(`A:${AREA_CODE}`);
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

test('요식업 업종 열 개를 모두 고를 수 있다', async ({ page }, testInfo) => {
  await seed(uniqueSuffix(testInfo.project.name));
  await openArea(page);
  const options = page.getByLabel('3. 업종').locator('option:not([value=""])');
  await expect(options).toHaveText(FOOD_INDUSTRIES.map(([code, , displayName]) => `${displayName} (${code})`));
});

test('점수 없는 업종도 상권 지표를 보여 주고, 점수를 0으로 만들거나 재무 계획으로 넘기지 않는다', async ({
  page,
}, testInfo) => {
  await seed(uniqueSuffix(testInfo.project.name));
  await openArea(page);
  const summaryResponse = responseFor(page, '/api/markets/report', CHINESE);
  const scoreResponse = responseFor(page, '/api/markets/score', CHINESE);
  await page.getByLabel('3. 업종').selectOption(CHINESE);

  // 상권 지표(report)는 점수와 따로 낸다(docs/domains/market.md). 매출 원값이 없는 분기는 null이고 화면에는 자료 부족이다.
  const summary = await (await summaryResponse).json();
  expect(summary.dataStatus).toBe('PARTIAL');
  expect(summary.quarters.map((q: { salesAmount: string | null }) => q.salesAmount)).toEqual(['45000000', null]);
  // 점수 패널에도 계수표가 있어 표는 caption(접근 이름)으로 찾는다.
  const table = page.getByRole('table', { name: 'E2E 요식업 상권 · 중식 · 가용 분기 2개' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row', { name: /2026년 1분기/ })).toContainText('45,000,000');
  await expect(
    table
      .getByRole('row', { name: /2026년 2분기/ })
      .getByRole('cell')
      .first(),
  ).toHaveText('자료 부족');

  // 점수는 미지원 상태로 내고 점수·월매출 기본값을 0이 아니라 비워 둔다(ADR 0008, AGENTS.md §3-2).
  const scoreRes = await scoreResponse;
  expect(scoreRes.status()).toBe(200);
  const score = await scoreRes.json();
  expect(score).toMatchObject({ status: 'UNSUPPORTED_INDUSTRY', score: null, financeDefault: null, storeCount: null });
  // 안내에는 점수를 내는 열린 업종만 적는다(ADR 0010 §2 생존점수).
  expect(score.servedIndustries.map((item: { code: string }) => item.code)).toEqual(['CS100001', FAST_FOOD]);

  const panel = page.locator('.score-panel');
  await expect(panel.getByRole('heading', { name: 'E2E 요식업 상권 · 중식' })).toBeVisible();
  await expect(panel.locator('.score-unavailable')).toContainText(
    '이 업종은 생존점수를 내지 않습니다. 점수는 현재 한식·패스트푸드만 냅니다.',
  );
  await expect(panel.locator('.score-value')).toHaveCount(0);
  // [이 상권으로 재무 계획 시작]은 점수가 있을 때만 있다(ADR 0008 §5).
  await expect(page.getByRole('link', { name: '이 상권으로 재무 계획 시작' })).toHaveCount(0);
});

test('점수 없는 업종의 상권 참조로 연 재무 계획은 값을 채우지 않는다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seed(suffix);
  // 화면에는 버튼이 없지만 주소를 직접 열 수 있다. 관측값은 사용자가 누른 버튼으로만 채운다(AGENTS.md §3-3).
  await page.goto(startUrl(CHINESE, releaseKey));
  await signUp(page, `food-unsupported-${suffix}@example.test`);
  await expect(page.locator('.status-message')).toContainText('이 업종은 생존점수를 내지 않습니다.');
  await expect(page.getByTestId('market-source')).toHaveCount(0);
  await expect(page.getByLabel('계획 제목')).toHaveValue('');
  // 월매출은 상권 값이 아니라 재무 화면의 기본 가정(core-flow와 같은 2천만 원) 그대로다.
  await expect(page.locator('#monthlyRevenue')).toHaveValue('20,000,000');
});

test('점수를 내는 새 업종은 점수에서 재무 계획을 시작한다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seed(suffix);
  await openArea(page);
  await page.getByLabel('3. 업종').selectOption(FAST_FOOD);

  await expect(page.getByRole('table', { name: 'E2E 요식업 상권 · 패스트푸드 · 가용 분기 2개' })).toBeVisible();
  const panel = page.locator('.score-panel');
  await expect(panel.getByRole('heading', { name: 'E2E 요식업 상권 · 패스트푸드' })).toBeVisible();
  await expect(panel.getByLabel('점수 64점, 등급 BBB')).toBeVisible();
  await expect(panel.getByText('서울 패스트푸드 상권 1곳 중 상위 100%')).toBeVisible();

  await panel.getByRole('link', { name: '이 상권으로 재무 계획 시작' }).click();
  await expect(page).toHaveURL(new RegExp(`scoreIndustry=${FAST_FOOD}`));
  await signUp(page, `food-fast-food-${suffix}@example.test`);

  await expect(page.getByTestId('market-source')).toContainText(
    'E2E 요식업 상권 패스트푸드 점포당 평균 기준 · 등급 BBB',
  );
  await expect(page.locator('#monthlyRevenue')).toHaveValue('2,400,000');
  await expect(page.getByLabel('계획 제목')).toHaveValue('E2E 요식업 상권 패스트푸드 계획');
  await expect(page.getByLabel('2. 사업장·거주 자치구')).toHaveValue('11200');

  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();
  const stored = await page.evaluate(async () => {
    const list = (await (await fetch('/api/plans')).json()) as { plans: Array<{ id: string }> };
    const detail = await (await fetch(`/api/plans/${list.plans[0].id}`)).json();
    return detail.plan as { marketScoreJson: Record<string, unknown> | null };
  });
  expect(stored.marketScoreJson).toMatchObject({
    releaseKey,
    industryCode: FAST_FOOD,
    grade: 'BBB',
    score: 64,
    monthlyRevenueDefault: '2400000',
  });
});
