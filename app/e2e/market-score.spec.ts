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
  // 재무 입력은 상권 점수를 받은 뒤에 나오므로 계획 목록으로 로그인 완료를 확인한다.
  await expect(page.getByRole('heading', { name: '내 계획', exact: true })).toBeVisible();
}

// [이 상권으로 재무 계획 시작]이 여는 주소. 화면은 참조만 넘긴다(ADR 0008 §5).
function startUrl(releaseKey: string): string {
  return `/?scoreAreaType=A&scoreArea=${AREA_CODE}&scoreIndustry=CS100001&scoreRelease=${releaseKey}`;
}

const SCORE_API = /\/api\/markets\/score\?/;

function uniqueSuffix(projectName: string): string {
  return `${projectName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function storedPlan(page: Page) {
  return page.evaluate(async () => {
    const list = (await (await fetch('/api/plans')).json()) as { plans: Array<{ id: string }> };
    const detail = await (await fetch(`/api/plans/${list.plans[0].id}`)).json();
    return detail.plan as { marketScoreJson: Record<string, unknown> | null; inputJson: { monthlyRevenue: string } };
  });
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
  // 자금 조건에는 자치구만 채운다(ADR 0009 §6의 ADR 0008 개정). 업종 입력란은 없어졌고(ADR 0009 §4), 나머지는 비어 있다.
  await expect(page.getByLabel('3. 업종 코드 (선택)')).toHaveCount(0);
  await expect(page.getByLabel('1. 사업자등록 여부')).toHaveValue('');
  await expect(page.getByLabel('3. 대표자 나이 (선택)')).toHaveValue('');

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
  await expect(page.getByLabel('2. 사업장·거주 자치구')).toHaveValue('11200');
  await expect(page.getByLabel('3. 업종 코드 (선택)')).toHaveCount(0);
  await expect(page.getByLabel('3. 대표자 나이 (선택)')).toHaveValue('');
});

// 해제는 상권 출처만 떼어 낸다. 해제 문구('미리 채운 값은 직접 고칠 수 있습니다')대로
// 사용자가 고친 값과 미리 채운 값이 모두 폼에 남아야 한다.
test('상권 연결을 해제해도 재무 입력이 그대로 남는다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seedScore(suffix);
  await page.goto(startUrl(releaseKey));
  await signUp(page, `market-unlink-${suffix}@example.test`);

  const source = page.getByTestId('market-source');
  await expect(source).toContainText('등급 A');
  await page.getByLabel('계획 제목').fill('내가 고친 제목');
  await page.locator('#rent').fill('1500000');
  await source.getByRole('button', { name: '상권 연결 해제' }).click();

  await expect(page.locator('.status-message')).toContainText('상권 연결을 해제했습니다.');
  await expect(source).toHaveCount(0);
  await expect(page.getByLabel('계획 제목')).toHaveValue('내가 고친 제목');
  await expect(page.locator('#rent')).toHaveValue('1,500,000');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('3,000,000');

  // 해제한 뒤 저장하면 상권 스냅샷 없이 폼에 남은 값만 저장한다.
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByText('초안을 저장했습니다.')).toBeVisible();
  const stored = await storedPlan(page);
  expect(stored.marketScoreJson).toBeNull();
  expect(stored.inputJson.monthlyRevenue).toBe('3000000');
});

// 점수 응답이 늦게 와도 사용자가 그동안 입력한 값을 덮으면 안 된다.
// 응답 전에는 재무 입력을 받지 않으므로 덮을 입력이 생기지 않는다.
test('상권 점수가 늦게 와도 재무 입력을 덮지 않는다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seedScore(suffix);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(SCORE_API, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(startUrl(releaseKey));
  await signUp(page, `market-late-${suffix}@example.test`);

  await expect(page.getByText('상권 점수를 불러오고 있습니다.')).toBeVisible();
  await expect(page.getByLabel('계획 제목')).toHaveCount(0);
  // 참조는 응답을 기다리지 않고 읽자마자 지운다. 그래야 로딩 중 새로고침·로그아웃 뒤에 다시 쓰지 않는다.
  await expect(page).not.toHaveURL(/scoreArea=/);
  release();
  await expect(page.getByTestId('market-source')).toContainText('등급 A');
  await expect(page.getByLabel('계획 제목')).toHaveValue('E2E 상권 한식 계획');
});

// 버튼을 누른 그 한 번만 채운다(ADR 0008 §5, AGENTS.md §3-3). 저장하지 않고 새로고침하거나,
// 떠났다가 일반 링크로 돌아오면 새 계획 기본값으로 시작해야 한다.
test('저장하지 않고 떠났다 돌아오면 상권 값을 다시 채우지 않는다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seedScore(suffix);
  await page.goto(startUrl(releaseKey));
  await signUp(page, `market-once-${suffix}@example.test`);
  await expect(page.getByTestId('market-source')).toContainText('등급 A');
  await expect(page).not.toHaveURL(/scoreArea=/);

  // 새 계획 기본값은 FinancePlanner의 defaults(월매출 20,000,000원)와 빈 제목·빈 자치구다.
  const expectBlankNewPlan = async () => {
    await expect(page.getByRole('heading', { name: /내 가정으로 확인하는 창업 재무계획/ })).toBeVisible();
    await expect(page.getByTestId('market-source')).toHaveCount(0);
    await expect(page.getByLabel('계획 제목')).toHaveValue('');
    await expect(page.locator('#monthlyRevenue')).toHaveValue('20,000,000');
    await expect(page.getByLabel('2. 사업장·거주 자치구')).toHaveValue('');
  };

  await page.reload();
  await expectBlankNewPlan();

  await page.goto(startUrl(releaseKey));
  await expect(page.getByTestId('market-source')).toContainText('등급 A');
  await page.getByRole('link', { name: '상권 탐색' }).click();
  await expect(page).toHaveURL(/\/markets/);
  await page.getByRole('link', { name: '내 창업 계획' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expectBlankNewPlan();
});

// /funding을 거쳐 next/link로 오가면 로그인 상태가 메모리에 남아, 계획 화면이 이동과 같은 렌더링에서 그려진다.
// 그때도 버튼이 넘긴 참조로만 채우고, 다른 화면 주소에 있던 참조로는 채우지 않아야 한다.
async function openFundingSignedIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: '이 결과가 무엇이고 무엇이 아닌지' })).toBeVisible();
}

test('화면 안에서 이동해 버튼을 눌러도 상권 값을 채운다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  await seedScore(suffix);
  await page.goto('/');
  await signUp(page, `market-softnav-${suffix}@example.test`);
  await openFundingSignedIn(page, '/funding');

  await page.locator('header').getByRole('link', { name: '상권 탐색' }).click();
  await page.getByLabel('1. 자치구').selectOption('11200');
  await page.getByLabel('2. 상권').selectOption(`A:${AREA_CODE}`);
  await page.getByLabel('3. 업종').selectOption('CS100001');
  await page.locator('.score-panel').getByRole('link', { name: '이 상권으로 재무 계획 시작' }).click();

  await expect(page.getByTestId('market-source')).toContainText('E2E 상권 한식 점포당 평균 기준 · 등급 A');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('3,000,000');
  await expect(page).not.toHaveURL(/scoreArea=/);
});

test('다른 화면 주소의 상권 참조로는 채우지 않는다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seedScore(suffix);
  await page.goto('/');
  await signUp(page, `market-funding-link-${suffix}@example.test`);
  // [자금 후보 보기]가 여는 주소. 등급을 표시할 뿐 재무 계획을 시작하는 버튼이 아니다.
  await openFundingSignedIn(page, `/funding${startUrl(releaseKey).slice(1)}`);
  await expect(page.getByTestId('funding-grade')).toContainText('등급 A');

  await page.locator('header').getByRole('link', { name: '내 창업 계획' }).click();
  await expect(page.getByRole('heading', { name: /내 가정으로 확인하는 창업 재무계획/ })).toBeVisible();
  await expect(page.getByTestId('market-source')).toHaveCount(0);
  await expect(page.getByLabel('계획 제목')).toHaveValue('');
  await expect(page.locator('#monthlyRevenue')).toHaveValue('20,000,000');
});

// 점수 API가 4xx·5xx를 내도 참조를 지운다. 남기면 /를 다시 열 때마다 같은 오류가 뜬다.
test('상권 점수 오류는 한 번만 알리고 참조를 지운다', async ({ page }, testInfo) => {
  const suffix = uniqueSuffix(testInfo.project.name);
  const releaseKey = await seedScore(suffix);
  await page.route(SCORE_API, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'SCORE_UNAVAILABLE', message: 'E2E 점수 오류입니다.' } },
    }),
  );
  await page.goto(startUrl(releaseKey));
  await signUp(page, `market-error-${suffix}@example.test`);
  await expect(page.locator('.status-message')).toContainText('E2E 점수 오류입니다.');
  await expect(page).not.toHaveURL(/scoreArea=/);

  // 점수 API가 정상으로 돌아와도 지운 참조로 다시 채우지 않는다.
  await page.unroute(SCORE_API);
  await page.reload();
  await expect(page.getByRole('heading', { name: /내 가정으로 확인하는 창업 재무계획/ })).toBeVisible();
  await expect(page.getByText('E2E 점수 오류입니다.')).toHaveCount(0);
  await expect(page.getByTestId('market-source')).toHaveCount(0);
});
