# 임대료 참고 도메인

결정 배경은 [ADR 0004](../decisions/0004-reb-rent-benchmark.md)에 있다.

## 코드 위치

- `app/src/features/rent-benchmark`: 부동산원 R-ONE 적재(`loader.ts`, `reb-api.ts`), 표 정의(`types.ts`), 조사 상권 → 자치구 연결(`regions.ts`), 환산(`estimate.ts`), 조회(`read.ts`), 계획 화면 패널(`RentBenchmarkPanel.tsx`).

## 적재

- 실행: `npm --prefix app run rent:load`. `app/.env.local`의 `REB_API_KEY`에 부동산통계정보시스템(R-ONE) Open API 인증키를 넣고 Git에는 추가하지 않는다.
- 원본: 한국부동산원 상업용부동산 임대동향조사의 2024년 3분기 이후 표 9개(소규모·중대형·집합 상가 × 지역별 임대료·층별 임대료·공실률). 표 ID와 이름은 `types.ts`에 있다.
- 서울 행만 저장한다. 원본 값(천원/㎡, %)과 빈 값(NULL)은 그대로 두고, 층별 표의 효용비율은 저장하지 않는다.
- 다음 경우에는 활성화하지 않는다.
  - 표 이름 불일치, 행 수 불일치
  - 알 수 없는 항목·단위·분기·층, 음수, 100% 초과 공실률
  - 표 사이 분기·지역 불일치, 중복 키
- 같은 내용을 다시 받으면 `ALREADY_ACTIVE`다.

## 조회

`GET /api/rent-benchmarks?buildingType=SMALL_RETAIL|MEDIUM_LARGE_RETAIL|COLLECTIVE_RETAIL&districtCode=11200`

- `districtCode`는 선택값이다. 서울 자치구 코드가 아니면 400이다.
- 활성 릴리스가 없으면 503 `DATASET_UNAVAILABLE`이다. 샘플 숫자나 0으로 성공 응답을 만들지 않는다.
- 조사 지역마다 다음 값을 돌려준다. 금액은 원 단위 정수 문자열이고, 원본 소수 값(`sourceValue`)도 함께 싣는다.
  - 최신 분기 대표 임대료(1층 기준)와 공실률
  - 층별 ㎡당 임대료
  - 대표 임대료 추이
- `district.regionPaths`는 그 자치구와 연결된 조사 상권이다. 연결은 상권 이름이 가리키는 위치 기준의 참고용이며, 버전은 `regionMappingVersion`이다.

## 계획 화면

- 사업 조건의 상가 유형·자치구로 조회한다. 조사 지역은 연결된 조사 상권 중 첫 곳을 기본으로 하고, 연결된 곳이 없으면 서울 전체로 한다. 사용자가 바꿀 수 있다.
- 월 임대료 참고값 = 선택 층 ㎡당 임대료 × 면적이다.
  - 입력한 면적은 임대 면적(전용+공용)으로 보고, 1평은 400/121㎡로 환산한다.
  - "2층 이상"은 2층 값을 쓴다.
  - 층 조사값이 없으면 다른 층으로 대체하지 않는다.
- 참고값은 재무 입력에 자동으로 넣지 않고 저장하지도 않는다. 부동산원 임대료는 보증금 환산분을 포함하므로, 저장된 월 임대료(월세)와 차이가 날 수 있다고 함께 표시한다.
