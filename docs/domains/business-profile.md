# 사업 조건 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

## 코드 위치

- `app/src/features/business-profile`: 위치·업종·면적·층·상가 유형 입력 검증과 활성 릴리스 provenance 저장.

## 사업 조건 저장

- `Plan.businessProfileJson`은 자치구·서울시 상위 업종·소진공 세부 업종·면적·층·상가 유형과 사용한 릴리스 키를 저장한다.
- 재무 `inputJson`, `INPUT_SCHEMA_VERSION`, 과거 `plan_results`는 바꾸거나 재계산하지 않는다.
- `PUT /api/plans/{planId}/business-profile`은 소유권과 revision을 검사한다. 계획 생성·일반 수정에서도 같은 스키마와 활성 릴리스 검증을 재사용한다.
