import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { BusinessDirectoryError, loadBusinessDirectory, parseBusinessDirectoryPage } from './loader.ts';
import { isMeatCategory, marketIndustryForSemas } from './mapping.ts';
import { getBusinessSummary, listBusinessCategories, resolveDetailedCategory } from './read.ts';

const ITEM = {
  bizesId: 'MA010120220800001234',
  bizesNm: '테스트고기집',
  brchNm: '',
  indsLclsCd: 'I2',
  indsLclsNm: '음식',
  indsMclsCd: 'I201',
  indsMclsNm: '한식',
  indsSclsCd: 'I20107',
  indsSclsNm: '돼지고기 구이/찜',
  ksicCd: '56113',
  ksicNm: '한식 육류요리 전문점',
  signguCd: '11440',
  signguNm: '마포구',
  adongCd: '11440660',
  adongNm: '서교동',
  lnoAdr: '서울 마포구 서교동 1',
  rdnmAdr: '서울 마포구 테스트로 1',
  lon: 126.9,
  lat: 37.5,
};

describe('소진공 상가(상권)정보 응답', () => {
  it('객체 항목을 손실 없이 정규화하고 한식 상위 업종에 매핑한다', () => {
    const parsed = parseBusinessDirectoryPage({ header: { resultCode: '00' }, body: { totalCount: 1, items: [ITEM] } });
    expect(parsed.totalCount).toBe(1);
    expect(parsed.records[0]).toMatchObject({
      sourceBusinessId: ITEM.bizesId,
      districtCode: '11440',
      smallCategoryCode: 'I20107',
      marketIndustryCode: 'CS100001',
      longitude: '126.9',
    });
  });

  it('columns와 배열로 온 항목도 공식 열 이름으로 해석한다', () => {
    const columns = Object.keys(ITEM);
    const parsed = parseBusinessDirectoryPage({
      header: { resultCode: '0', columns },
      body: { totalCount: '1', items: [columns.map((column) => ITEM[column as keyof typeof ITEM])] },
    });
    expect(parsed.records[0].businessName).toBe('테스트고기집');
  });

  it('상류 오류와 필수값 누락을 성공으로 취급하지 않는다', () => {
    expect(() =>
      parseBusinessDirectoryPage({ header: { resultCode: '20', resultMsg: 'SERVICE KEY IS NULL' } }),
    ).toThrow(BusinessDirectoryError);
    expect(() =>
      parseBusinessDirectoryPage({
        header: { resultCode: '00' },
        body: { totalCount: 1, items: [{ ...ITEM, bizesId: '' }] },
      }),
    ).toThrow('필수');
  });
});

// 2026-11-24 서울 25개 자치구 음식(I2) 업소 137,172곳에서 나온 분류 43개 전부와 사람이 정한 대응(ADR 0010 6단계).
// null은 대응하지 않아 적재하지 않는 분류다.
const SURVEYED_CATEGORIES: readonly (readonly [
  middleCode: string,
  smallCode: string,
  smallName: string,
  expected: string | null,
])[] = [
  ...(
    [
      ['I20101', '백반/한정식'],
      ['I20102', '국/탕/찌개류'],
      ['I20103', '족발/보쌈'],
      ['I20104', '전/부침개'],
      ['I20105', '국수/칼국수'],
      ['I20106', '냉면/밀면'],
      ['I20107', '돼지고기 구이/찜'],
      ['I20108', '소고기 구이/찜'],
      ['I20109', '곱창 전골/구이'],
      ['I20110', '닭/오리고기 구이/찜'],
      ['I20111', '횟집'],
      ['I20112', '해산물 구이/찜'],
      ['I20113', '복 요리 전문'],
      ['I20199', '기타 한식 음식점'],
    ] as const
  ).map(([code, name]) => ['I201', code, name, 'CS100001'] as const), // 중분류 한식 전체 → 한식(지금과 같다)
  ['I202', 'I20201', '중국집', 'CS100002'],
  ['I202', 'I20202', '마라탕/훠궈', 'CS100002'],
  ['I203', 'I20301', '일식 회/초밥', 'CS100003'],
  ['I203', 'I20302', '일식 카레/돈가스/덮밥', 'CS100003'],
  ['I203', 'I20303', '일식 면 요리', 'CS100003'],
  ['I203', 'I20399', '기타 일식 음식점', 'CS100003'],
  ['I204', 'I20401', '경양식', 'CS100004'],
  ['I204', 'I20402', '파스타/스테이크', 'CS100004'],
  ['I204', 'I20403', '패밀리레스토랑', 'CS100004'],
  ['I204', 'I20499', '기타 서양식 음식점', 'CS100004'],
  // 서울시 상위 업종 열 개에 동남아·기타 외국식·구내식당·뷔페는 없다.
  ['I205', 'I20501', '베트남식 전문', null],
  ['I205', 'I20599', '기타 동남아식 전문', null],
  ['I206', 'I20601', '분류 안된 외국식 음식점', null],
  ['I207', 'I20701', '구내식당', null],
  ['I207', 'I20702', '뷔페', null],
  ['I210', 'I21001', '빵/도넛', 'CS100005'],
  // 사용자 결정: 떡집은 제조·소매 성격이 강해 제과점에 넣지 않는다.
  ['I210', 'I21002', '떡/한과', null],
  // 사용자 결정: 피자·버거·토스트/샌드위치/샐러드는 패스트푸드점으로 묶는다.
  ['I210', 'I21003', '피자', 'CS100006'],
  ['I210', 'I21004', '버거', 'CS100006'],
  ['I210', 'I21005', '토스트/샌드위치/샐러드', 'CS100006'],
  ['I210', 'I21006', '치킨', 'CS100007'],
  ['I210', 'I21007', '김밥/만두/분식', 'CS100008'],
  // 사용자 결정: 아이스크림/빙수는 열 개 업종 어디에도 맞지 않는다.
  ['I210', 'I21008', '아이스크림/빙수', null],
  ['I210', 'I21099', '그 외 기타 간이 음식점', null],
  // 사용자 결정: 유흥 주점은 창업 대상 간이주점과 달라 넣지 않는다.
  ['I211', 'I21101', '일반 유흥 주점', null],
  ['I211', 'I21102', '무도 유흥 주점', null],
  ['I211', 'I21103', '생맥주 전문', 'CS100009'],
  ['I211', 'I21104', '요리 주점', 'CS100009'],
  ['I212', 'I21201', '카페', 'CS100010'], // 지금과 같다
];

describe('소진공 업종 매핑', () => {
  it('조사한 분류 43개를 사람이 정한 대로 서울시 상위 업종에 대응시킨다', () => {
    expect(SURVEYED_CATEGORIES).toHaveLength(43);
    expect(
      SURVEYED_CATEGORIES.map(([middleCode, smallCode, smallName]) => [
        smallCode,
        smallName,
        marketIndustryForSemas({ middleCode, smallCode }),
      ]),
    ).toEqual(SURVEYED_CATEGORIES.map(([, smallCode, smallName, expected]) => [smallCode, smallName, expected]));
  });

  it('업종 하나로 묶인 중분류에 새 소분류가 생기면 그 업종으로, 나뉘는 중분류의 새 소분류는 대응하지 않는다', () => {
    // 한식 중분류 전체를 한식으로 보던 지금 규칙을 유지한다. 기타 간이·주점은 소분류마다 사람이 정했다.
    expect(marketIndustryForSemas({ middleCode: 'I201', smallCode: 'I20114' })).toBe('CS100001');
    expect(marketIndustryForSemas({ middleCode: 'I210', smallCode: 'I21009' })).toBeNull();
    expect(marketIndustryForSemas({ middleCode: 'I211', smallCode: 'I21105' })).toBeNull();
  });

  it('고깃집 여부를 별도로 표시한다', () => {
    expect(isMeatCategory('소고기 구이/찜')).toBe(true);
    expect(isMeatCategory('중국집')).toBe(false);
  });
});

function semasItem(id: string, middleCode: string, middleName: string, smallCode: string, smallName: string) {
  return {
    ...ITEM,
    bizesId: id,
    bizesNm: `${smallName} 업소 ${id}`,
    indsMclsCd: middleCode,
    indsMclsNm: middleName,
    indsSclsCd: smallCode,
    indsSclsNm: smallName,
  };
}

// 마포구에만 업소가 있는 가짜 소진공 API. 다른 자치구는 0건이다.
function semasFetcher(items: readonly ReturnType<typeof semasItem>[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const rows = url.searchParams.get('key') === '11440' && url.searchParams.get('pageNo') === '1' ? items : [];
    const total = url.searchParams.get('key') === '11440' ? items.length : 0;
    return new Response(JSON.stringify({ header: { resultCode: '00' }, body: { totalCount: total, items: rows } }));
  }) as typeof fetch;
}

// 합성 스냅샷을 전용 테스트 DB에 적재하고, 끝나면 지우고 이전 ACTIVE를 되돌린다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('소진공 점포 스냅샷 적재·조회(PostgreSQL)', () => {
  let client: PrismaClient | null = null;
  let previousActiveId: string | null = null;
  let startedAt = new Date(0);
  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    startedAt = new Date();
    previousActiveId = (await db().businessDirectoryRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
  });

  afterAll(async () => {
    await db().businessDirectoryRelease.deleteMany({ where: { createdAt: { gte: startedAt } } });
    if (previousActiveId) {
      await db().businessDirectoryRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      await db().businessDirectoryRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
    }
    await db().$disconnect();
  });

  it('요식업 업종 열 개의 점포를 적재하고 모두 조회한다', async () => {
    // 업종마다 대응표(ADR 0010 §2의 경쟁 점포)에 있는 소분류 하나씩. 업종 코드는 대응표에서 나온다.
    const perIndustry = [
      ['B01', 'I201', '한식', 'I20107', '돼지고기 구이/찜', 'CS100001'],
      ['B02', 'I202', '중식', 'I20201', '중국집', 'CS100002'],
      ['B03', 'I203', '일식', 'I20301', '일식 회/초밥', 'CS100003'],
      ['B04', 'I204', '서양식', 'I20401', '경양식', 'CS100004'],
      ['B05', 'I210', '기타 간이', 'I21001', '빵/도넛', 'CS100005'],
      ['B06', 'I210', '기타 간이', 'I21004', '버거', 'CS100006'],
      ['B07', 'I210', '기타 간이', 'I21006', '치킨', 'CS100007'],
      ['B08', 'I210', '기타 간이', 'I21007', '김밥/만두/분식', 'CS100008'],
      ['B09', 'I211', '주점', 'I21103', '생맥주 전문', 'CS100009'],
      ['B10', 'I212', '비알코올', 'I21201', '카페', 'CS100010'],
    ] as const;
    const items = [
      ...perIndustry.map(([id, middleCode, middleName, smallCode, smallName]) =>
        semasItem(id, middleCode, middleName, smallCode, smallName),
      ),
      semasItem('B11', 'I205', '동남아시아', 'I20501', '베트남식 전문'),
    ];
    const result = await loadBusinessDirectory({
      prisma: db(),
      serviceKey: 'TESTKEY',
      fetcher: semasFetcher(items),
      retrievedAt: new Date('2026-11-24T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('ACTIVATED');
    // 대응하지 못한 베트남식(B11)만 빠진다.
    expect(result.businessCount).toBe(10);

    // 열 개 업종을 모두 열었으므로(ADR 0010 7단계) 업종마다 소분류가 하나씩 보인다.
    const categories = await listBusinessCategories(db());
    expect(categories.categories.map((category) => [category.code, category.marketIndustryCode])).toEqual(
      perIndustry.map(([, , , smallCode, , industryCode]) => [smallCode, industryCode]),
    );
    const chinese = await getBusinessSummary(db(), { districtCode: '11440', detailedIndustryCode: 'I20201' });
    expect(chinese.kind === 'OK' ? chinese.payload.businessCount : chinese.kind).toBe(1);
    // 세부 업종은 자기 상위 업종에서만 고를 수 있다. 중국집은 한식의 세부 업종이 아니다.
    expect(await resolveDetailedCategory(db(), 'I20201', 'CS100001')).toBeNull();
    expect(await resolveDetailedCategory(db(), 'I20201', 'CS100002')).not.toBeNull();
  }, 60000);

  it('열린 업종의 점포가 하나도 없으면 활성화하지 않고 기존 ACTIVE를 유지한다', async () => {
    const before = await db().businessDirectoryRelease.findFirst({ where: { status: 'ACTIVE' } });
    // 커피·음료 점포가 없다. 그대로 활성화하면 커피·음료 경쟁 점포가 0곳인 것처럼 보인다(AGENTS.md §3의 2번).
    const items = [
      semasItem('C1', 'I201', '한식', 'I20101', '백반/한정식'),
      semasItem('C2', 'I202', '중식', 'I20201', '중국집'),
    ];
    await expect(
      loadBusinessDirectory({ prisma: db(), serviceKey: 'TESTKEY', fetcher: semasFetcher(items) }),
    ).rejects.toMatchObject({ code: 'NO_SUPPORTED_BUSINESS' });
    expect((await db().businessDirectoryRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id).toBe(before?.id);
  }, 60000);
});
