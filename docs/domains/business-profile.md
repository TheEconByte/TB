# 사업 조건 도메인

이 문서는 사업 조건의 구현 계약(API·적재·계산 정책과 테스트 범위)의 단일 원본이다. 이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 파일을 고친다. 제품 전체의 불변 계약은 [PROJECT_CONTEXT.md §6](../PROJECT_CONTEXT.md#6-변경하면-안-되는-계약), 코드 지도는 [ARCHITECTURE.md](../ARCHITECTURE.md)를 따른다.

## 코드 위치

- `app/src/features/business-profile`: 위치·업종·면적·층·상가 유형 입력 검증과 활성 릴리스 provenance 저장.

## 사업 조건 저장

- `Plan.businessProfileJson`은 자치구·서울시 상위 업종·소진공 세부 업종·면적·층·상가 유형과 사용한 릴리스 키를 저장한다.
- 재무 `inputJson`, `INPUT_SCHEMA_VERSION`, 과거 `plan_results`는 바꾸거나 재계산하지 않는다.
- `PUT /api/plans/{planId}/business-profile`은 소유권과 revision을 검사한다. 계획 생성·일반 수정에서도 같은 스키마와 활성 릴리스 검증을 재사용한다.
