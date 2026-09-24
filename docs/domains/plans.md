# 계획·불변 결과 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

## 코드 위치

- `app/src/features/plans`: 인증 후 계획 목록·입력·결과 이력 UI, 결과 키(`calculation-key.ts`), 계획에 저장한 자금 조건과 그 조건 판정 조립(`funding-matches.ts`), API 경계 테스트.
- 계산 공식과 시나리오는 [finance.md](finance.md)에 있다.

## API

- `/api/auth/*`: Better Auth handler.
- `/api/plans`: 내 계획 생성·목록.
- `/api/plans/{id}`: 소유자만 상세·revision 수정·삭제.
- `/api/plans/{id}/calculations`: 저장된 입력만 서버에서 계산하고 결과를 append-only로 저장.
- `/api/plans/{id}/business-profile`: 소유자만 사업 조건을 저장하고 revision을 올림([business-profile.md](business-profile.md)).
- `/api/plans/{id}/funding-matches`: 저장된 계획 조건으로만 자금 후보를 판정하고 결과를 저장하지 않음.
- `/api/plans/{id}/loan-assumption`: 사용자가 고른 상품 버전의 확정 조건을 계획의 신규 대출 가정으로 적용하고 revision을 올림.
- `/api/plans/{id}/results[/{resultId}]`: 소유자만 결과 목록·상세 조회.
- 미로그인은 401, 타인 리소스와 없는 ID는 404, 입력 오류는 400, 오래된 revision은 409다.

## 계산 결과 보존

- 계산은 저장된 초안(`plans.inputJson`)만 쓴다. 화면에서 저장하지 않은 입력은 계산하지 않는다. 저장된 초안이 현재 입력 스키마와 맞지 않으면 400이다.
- 결과 키 `calculationKey`는 계획 id, 입력 revision, 입력 스키마 버전, 계산 버전의 SHA-256이다(`calculation-key.ts`).
  - 같은 키의 결과가 이미 있으면 다시 계산하지 않고 기존 결과를 200 `reused: true`로 돌려준다. 새 결과는 201이다.
  - 계산 버전이 키에 들어가므로, 계산식을 바꾸고 `CALCULATION_VERSION`을 올리지 않으면 같은 revision에서 이전 결과가 재사용된다.
- 결과 행(`plan_results`)에는 입력 스냅샷(`inputSnapshot`), 결과(`resultJson`), 입력 revision·스키마 버전·계산 버전, 계산 시각을 저장한다. 상품 확정 조건을 적용한 계획이면 그 출처(`loanAssumptionJson`)도 복사한다([funding.md](funding.md)).
- 결과를 수정하는 API는 없다. 계획을 수정하면 revision이 올라가고, 다음 계산이 새 결과를 추가한다. 계산 버전이 바뀌어도 과거 결과를 자동으로 다시 계산하지 않는다.
- 삭제: 계획을 삭제하면(`DELETE /api/plans/{id}`, 204) 그 계획의 결과도 함께 삭제된다(`onDelete: Cascade`). 사용자 행을 지워도 계획과 결과가 함께 삭제된다. 이 삭제와 append-only 계약(AGENTS.md §3의 7번)의 관계는 #17에서 정한다.
