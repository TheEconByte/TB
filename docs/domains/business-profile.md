# 사업 조건 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

## 코드 위치

- `app/src/features/business-profile`: 위치·업종·면적·층·상가 유형 입력 검증과 활성 릴리스 provenance 저장.

## 사업 조건 저장

- `Plan.businessProfileJson`은 자치구·서울시 상위 업종·소진공 세부 업종·면적·층·상가 유형과 사용한 릴리스 키를 저장한다.
- 재무 `inputJson`, `INPUT_SCHEMA_VERSION`, 과거 `plan_results`는 바꾸거나 재계산하지 않는다.
- `PUT /api/plans/{planId}/business-profile`은 소유권과 revision을 검사한다. 계획 생성·일반 수정에서도 같은 스키마와 활성 릴리스 검증을 재사용한다.
- 필수값(자치구·상위 업종·면적·층·상가 유형)이 모두 있어야 저장된다. 계획 화면은 필수값이 하나라도 빠지면 초안 저장 때 `businessProfile: null`을 보내고, 서버는 `null`을 받으면 저장된 사업 조건을 비운다. 그래서 이전에 저장한 조건도 지워진다.
