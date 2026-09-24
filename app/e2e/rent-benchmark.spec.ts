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

// 합성 부동산원 릴리스. 서울·권역·조사 상권 2곳, 2개 분기, 소규모 상가만 넣는다.
async function seedRentRelease(suffix: string): Promise<void> {
  const db = pool();
  const releaseId = `e2e-rent-${suffix}`;
  releaseIds.add(releaseId);
  const rows: Array<[string, string, string, number, string, string | null, string]> = [];
  const regions: Array<[string, number, Record<string, string | null>]> = [
    ['서울', 1, { RENT: '50', B1: '25', '1F': '50', '2F': '30', VACANCY: '10.25' }],
    ['서울>기타', 2, { RENT: '45', B1: '20', '1F': '45', '2F': '28', VACANCY: '9.5' }],
    ['서울>기타>뚝섬', 3, { RENT: '60', B1: null, '1F': '60', '2F': '35', VACANCY: '8' }],
    ['서울>기타>왕십리', 3, { RENT: '40', B1: '18', '1F': '40', '2F': '22', VACANCY: '7' }],
  ];
  for (const quarter of ['20261', '20262']) {
    for (const [path, level, values] of regions) {
      const earlier = (value: string | null) =>
        value === null || quarter === '20262' ? value : String(Number(value) - 1);
      rows.push(['RENT', quarter, path, level, 'NONE', earlier(values.RENT), '천원/㎡']);
      rows.push(['VACANCY_RATE', quarter, path, level, 'NONE', values.VACANCY, '%']);
      for (const floor of ['B1', '1F', '2F'])
        rows.push(['FLOOR_RENT', quarter, path, level, floor, earlier(values[floor]), '천원/㎡']);
    }
  }
  try {
    await db.query(
      `INSERT INTO rent_benchmark_releases (id, "releaseKey", status, "schemaVersion", "sourceUrl", "basisPeriod",
        "basisPeriodLabel", "retrievedAt", "sourceTables", "validationSummary", "observationCount", "activatedAt", "updatedAt")
       VALUES ($1, $1, 'ACTIVE', 'reb-rent-benchmark-v1.0.0', 'https://www.reb.or.kr/', '20261-20262',
        '2026년 1분기~2분기', now(), '[]', '{}', $2, now() + interval '1 day', now())`,
      [releaseId, rows.length],
    );
    for (const [index, [metric, quarter, path, level, floor, value, unit]] of rows.entries()) {
      await db.query(
        `INSERT INTO rent_benchmark_observations (id, "releaseId", "buildingType", metric, quarter, "regionPath",
          "regionName", "regionLevel", floor, value, unit, "sourceTableId")
         VALUES ($1, $2, 'SMALL_RETAIL', $3, $4, $5, $6, $7, $8, $9, $10, 'e2e')`,
        [`${releaseId}-${index}`, releaseId, metric, quarter, path, path.split('>').at(-1), level, floor, value, unit],
      );
    }
  } finally {
    await db.end();
  }
}

async function signUp(page: Page, email: string): Promise<void> {
  createdEmails.add(email);
  await page.getByRole('button', { name: '계정이 없나요? 회원가입' }).click();
  await page.getByLabel('이름').fill('임대료 확인');
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
      await db.query('DELETE FROM rent_benchmark_releases WHERE id = ANY($1::text[])', [[...releaseIds]]);
  } finally {
    createdEmails.clear();
    releaseIds.clear();
    await db.end();
  }
});

test('사업 조건에 맞는 부동산원 임대료를 참고값으로 보여 준다', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await seedRentRelease(suffix);
  await page.goto('/');
  await signUp(page, `rent-${suffix}@example.test`);

  const panel = page.getByRole('region', { name: '임대료 참고' });
  await expect(panel.getByText('사업 조건에서 상가 유형을 고르면')).toBeVisible();

  // 입력 확인 단계는 빠진 항목을 알려 주고, 그 항목을 입력하는 단계로 보낸다.
  const wizard = page.locator('.business-wizard');
  await wizard.getByRole('button', { name: /입력 확인/ }).click();
  await expect(wizard.getByText('빠진 항목: 지역구, 업종, 면적, 층, 상가 유형')).toBeVisible();
  await wizard.getByRole('button', { name: '빠진 항목 입력', exact: true }).click();
  await expect(page.getByLabel('지역구')).toBeVisible();

  // 사업 조건을 일부만 입력하면 저장하지 않는다(저장된 조건이 null로 지워지는 것을 막는다).
  // 모두 비우면 사업 조건 없는 계획으로 저장된다.
  await page.getByLabel('계획 제목').fill(`임대료 확인 ${suffix}`);
  await page.getByLabel('지역구').selectOption('11200');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.locator('.status-message')).toContainText(
    '사업 조건에 빠진 항목이 있어 저장하지 않았습니다: 업종, 면적, 층, 상가 유형',
  );
  await expect(page.getByText('저장된 계획이 없습니다.')).toBeVisible();
  await wizard.getByRole('button', { name: /입력 확인/ }).click();
  await wizard.getByRole('button', { name: '사업 조건 모두 비우기' }).click();
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.locator('.status-message')).toContainText('초안을 저장했습니다.');
  await wizard.getByRole('button', { name: '빠진 항목 입력', exact: true }).click();

  await page.getByLabel('지역구').selectOption('11200');
  await page.getByLabel('업종 대분류').selectOption('CS100010');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('정확한 면적').fill('10');
  await page.getByRole('button', { name: '다음' }).click();
  await page.locator('.choice-card', { has: page.locator('strong', { hasText: /^1층$/ }) }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: /소규모 상가/ }).click();

  // 다 입력하면 입력 확인에 층·상가 유형까지 보이고, 다음 버튼이 아래 참고 자료로 넘어간다.
  await wizard.getByRole('button', { name: '다음', exact: true }).click();
  await expect(wizard.getByText('저장 가능')).toBeVisible();
  await expect(wizard.locator('.profile-summary-grid')).toContainText('1층');
  await expect(wizard.locator('.profile-summary-grid')).toContainText('소규모 상가');
  await wizard.getByRole('button', { name: '다음: 참고 자료', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '임대료 참고' })).toBeInViewport();

  // 성동구와 겹치는 조사 상권(뚝섬)이 먼저 선택되고, 10평(400/121㎡×10) × 1층 60천원/㎡로 계산한다.
  const region = panel.getByLabel('조사 지역');
  await expect(region).toHaveValue('서울>기타>뚝섬');
  await expect(panel.getByText('성동구와 겹치는 조사 상권 2곳이 위에 있습니다.')).toBeVisible();
  await expect(panel.getByText('1,983,471원')).toBeVisible();
  await expect(panel.getByText('1층 ㎡당 임대료 × 33.1㎡')).toBeVisible();
  await expect(panel.locator('.reference-summary > div', { hasText: '대표 ㎡당 월 임대료' })).toContainText('60,000원');
  await expect(panel.getByText('8.0%')).toBeVisible();

  // 자치구 밖 지역으로 바꾸면 그 지역 값으로 다시 계산한다. 원본이 비운 층은 0이 아니라 자료 없음이다.
  await region.selectOption('서울');
  await expect(panel.getByText('1,652,893원')).toBeVisible();
  await region.selectOption('서울>기타>뚝섬');
  await expect(panel.locator('.metric-row', { hasText: '지하 1층' })).toContainText('자료 없음');

  await page.locator('.business-wizard').screenshot({ path: testInfo.outputPath('business-profile.png') });
  await panel.screenshot({ path: testInfo.outputPath('rent-panel.png') });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
