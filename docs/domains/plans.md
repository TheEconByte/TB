# 계획·불변 결과 도메인

이 문서는 계획·불변 결과의 구현 계약(API·적재·계산 정책과 테스트 범위)의 단일 원본이다. 이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 파일을 고친다. 제품 전체의 불변 계약은 [PROJECT_CONTEXT.md §6](../PROJECT_CONTEXT.md#6-변경하면-안-되는-계약), 코드 지도는 [ARCHITECTURE.md](../ARCHITECTURE.md)를 따른다.

## 코드 위치

- `app/src/features/plans`: 인증 후 계획 목록·입력·결과 이력 UI, 계획에 저장한 자금 조건과 그 조건 판정 조립(`funding-matches.ts`), API 경계 테스트.

## F2 API 정책

- `/api/auth/*`: Better Auth handler.
- `/api/plans`: 내 계획 생성·목록.
- `/api/plans/{id}`: 소유자만 상세·revision 수정·삭제.
- `/api/plans/{id}/calculations`: 저장된 입력만 서버에서 계산하고 결과를 append-only로 저장.
- `/api/plans/{id}/funding-matches`: 저장된 계획 조건으로만 자금 후보를 판정하고 결과를 저장하지 않음.
- `/api/plans/{id}/loan-assumption`: 사용자가 고른 상품 버전의 확정 조건을 계획의 신규 대출 가정으로 적용하고 revision을 올림.
- `/api/plans/{id}/results[/{resultId}]`: 소유자만 결과 목록·상세 조회.
- 미로그인은 401, 타인 리소스와 없는 ID는 404, 입력 오류는 400, 오래된 revision은 409다.
