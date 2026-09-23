import { describe, expect, it } from 'vitest';
import { BusinessDirectoryError, parseBusinessDirectoryPage } from './loader.ts';
import { isMeatCategory, marketIndustryForSemas } from './mapping.ts';

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

describe('소진공 업종 매핑', () => {
  it('한식·커피만 서울시 상위 업종에 연결하고 고깃집 여부를 별도로 표시한다', () => {
    expect(marketIndustryForSemas({ middleName: '한식', smallCode: 'I20107', smallName: '돼지고기 구이/찜' })).toBe(
      'CS100001',
    );
    expect(marketIndustryForSemas({ middleName: '비알코올 음료점업', smallCode: 'I21201', smallName: '카페' })).toBe(
      'CS100010',
    );
    expect(marketIndustryForSemas({ middleName: '일식', smallCode: 'I20301', smallName: '일식 회/초밥' })).toBeNull();
    expect(isMeatCategory('소고기 구이/찜')).toBe(true);
  });
});
