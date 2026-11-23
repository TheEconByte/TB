import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { resolveBusinessProfile } from './resolve.ts';
import type { BusinessProfileInput } from './schema.ts';

// 사업 조건 스키마는 요식업 업종 코드를 모두 받는다. 그중 고를 수 있는 업종은 활성 상권 릴리스가
// 지원하는 업종뿐이다(ADR 0010 3단계). 열지 않은 업종을 저장하면 상권·경쟁 점포 화면이 빈 결과가 된다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('사업 조건의 업종 확인', () => {
  let client: PrismaClient | null = null;
  const releaseId = `test-business-profile-${Date.now()}`;
  const db = () => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };
  const input = (marketIndustryCode: BusinessProfileInput['marketIndustryCode']): BusinessProfileInput => ({
    districtCode: '11200',
    marketIndustryCode,
    detailedIndustryCode: null,
    area: { value: '20', unit: 'PYEONG' },
    floor: 'GROUND_1',
    buildingType: 'SMALL_RETAIL',
  });

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    // 활성화 시각을 미래로 두어 기존 ACTIVE보다 먼저 조회되게 한다.
    await db().marketRelease.create({
      data: {
        id: releaseId,
        releaseKey: releaseId,
        label: '합성 상권 릴리스',
        status: 'ACTIVE',
        schemaVersion: 'test',
        definitionVersion: 'test',
        sourceUrl: 'https://data.seoul.go.kr/',
        basisPeriod: '20252',
        basisPeriodLabel: '2025년 2분기',
        retrievedAt: new Date(),
        files: [],
        validationSummary: {},
        activatedAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const [code, isSupported] of [
      ['CS100001', true],
      ['CS100002', false],
    ] as const) {
      await db().industry.create({
        data: {
          releaseId,
          code,
          sourceName: code,
          displayName: code === 'CS100001' ? '한식' : '중식음식점',
          displayNameSource: 'TEST',
          sourceCategoryVersion: 'test',
          isSupported,
        },
      });
    }
  });

  afterAll(async () => {
    await db().marketRelease.deleteMany({ where: { id: releaseId } });
    await client?.$disconnect();
  });

  it('릴리스가 지원하는 업종은 저장할 사업 조건이 된다', async () => {
    const outcome = await resolveBusinessProfile(db(), input('CS100001'));
    expect(outcome).toMatchObject({
      kind: 'OK',
      profile: {
        marketIndustryCode: 'CS100001',
        marketIndustryName: '한식',
        provenance: { marketReleaseKey: releaseId },
      },
    });
  });

  it('스키마가 받아도 릴리스가 지원하지 않는 업종은 거부한다', async () => {
    expect(await resolveBusinessProfile(db(), input('CS100002'))).toEqual({ kind: 'INDUSTRY_NOT_FOUND' });
  });
});
