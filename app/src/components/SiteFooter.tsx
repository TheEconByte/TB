// 모든 화면의 꼬리말(layout.tsx). 화면에 쓰는 공공 자료의 출처 기관을 밝힌다.
// 자료별 기준기간과 원본 링크는 그 자료를 보여 주는 화면의 출처 칸에 있다.
const SOURCES = [
  '서울시 상권분석서비스',
  '소상공인시장진흥공단 상가(상권)정보',
  '한국부동산원 상업용부동산 임대동향조사',
  '공정거래위원회 가맹사업 정보공개서',
  '소상공인시장진흥공단 정책자금',
  '기업마당',
] as const;

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div>
          <strong>TrendBench</strong>
          <p>서울 음식점·카페 창업용 상권 조회, 재무 계산, 자금 공고 확인.</p>
        </div>
        <div>
          <strong>자료 출처</strong>
          <ul>
            {SOURCES.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
