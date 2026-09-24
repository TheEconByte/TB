# 소진공 세부 업종 점포 도메인

## 코드 위치

- `app/src/features/business-directory`: 소진공 점포 스냅샷 적재, 상위·세부 업종 매핑, 경쟁 점포 조회.

## 소진공 세부 업종 점포 스냅샷

- 실행: `npm --prefix app run business:load`. `app/.env.local`의 `SEMAS_SERVICE_KEY`에는 공공데이터포털 일반 인증키(Decoding)를 넣고 Git에는 추가하지 않는다.
- 운영자가 서울 25개 자치구의 음식점 업소를 API에서 순차 수집한다.
- 릴리스 키는 수집일과 응답 checksum으로 만든다. 그래서 적재 시점에 따라 PC마다 키와 건수가 다를 수 있다.
- API 오류·누락 필드·중복 상가업소번호·지원 업종 0건은 활성화를 막는다.
- `/api/business-categories`는 활성 스냅샷의 한식·커피 세부 업종을 반환한다. 활성 릴리스가 없으면 200과 빈 목록, `nullReason`을 반환한다.
- `/api/businesses/summary?districtCode=...&detailedIndustryCode=...`는 자치구·세부 업종 점포 수와 최대 50개 점포를 반환한다. 이 값은 매출이 아니며 서울시 추정매출과 합치지 않는다.
