# 소진공 세부 업종 점포 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

## 코드 위치

- `app/src/features/business-directory`: 소진공 점포 스냅샷 적재, 상위·세부 업종 매핑, 경쟁 점포 조회.

## 소진공 세부 업종 점포 스냅샷

- 실행: `npm --prefix app run business:load`. `app/.env.local`의 `SEMAS_SERVICE_KEY`에는 공공데이터포털 일반 인증키(Decoding)를 넣고 Git에는 추가하지 않는다.
- 기준 스냅샷: 2026-09-23 수집 릴리스 `semas-seoul-food-20260923-f8bbe2d4bc44`, 서울 음식점 74,361건, 제품에 매핑된 세부 업종 15개. 릴리스 키는 수집일과 응답 checksum으로 만들어지므로 PC마다 적재 시점에 따라 키와 건수가 다를 수 있다.
- 운영자가 서울 25개 자치구의 음식점 업소를 API에서 순차 수집한다. 웹 요청 처리 중에는 외부 API를 호출하지 않는다.
- API 오류·누락 필드·중복 상가업소번호·지원 업종 0건은 활성화를 막는다. 새 스냅샷 검증이 끝날 때까지 기존 ACTIVE 스냅샷을 유지한다.
- `/api/business-categories`는 활성 스냅샷의 한식·커피 세부 업종을 반환한다. 활성 릴리스가 없으면 200과 빈 목록, `nullReason`을 반환한다.
- `/api/businesses/summary?districtCode=...&detailedIndustryCode=...`는 자치구·세부 업종 점포 수와 최대 50개 점포를 반환한다. 이 값은 매출이 아니며 서울시 추정매출과 합치지 않는다.
- `/api/franchises`는 검수 스냅샷이 생기기 전까지 503 `DATASET_UNAVAILABLE`다. 샘플 숫자나 0으로 성공 응답을 만들지 않는다.
