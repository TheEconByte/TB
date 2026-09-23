# 도메인별 구현 계약

API·적재·계산 정책과 도메인 테스트 범위는 아래 도메인 문서가 단일 원본이다. 서로 다른 도메인 작업이 같은 파일을 고치지 않도록 다른 문서에 복사하지 않는다. 도메인을 바꾸는 PR은 코드·테스트와 함께 해당 문서 하나만 고친다.

| 도메인 | 문서 | 코드 |
|---|---|---|
| 재무 계산 | [finance.md](finance.md) | `app/src/features/finance` |
| 계획·불변 결과·계획 API | [plans.md](plans.md) | `app/src/features/plans` |
| 서울시 상권 적재·공개 API | [market.md](market.md) | `app/src/features/market` |
| 소진공 세부 업종 점포 | [business-directory.md](business-directory.md) | `app/src/features/business-directory` |
| 사업 조건 저장 | [business-profile.md](business-profile.md) | `app/src/features/business-profile` |
| 자금 카탈로그·후보·대출 가정 적용 | [funding.md](funding.md) | `app/src/features/funding`, `app/catalog/funding` |
| 웹 요청 보안 경계 | [security.md](security.md) | `app/src/lib` |

제품 전체의 변경 금지 계약은 [PROJECT_CONTEXT.md §6](../PROJECT_CONTEXT.md#6-변경하면-안-되는-계약)을 따른다. 새 도메인을 추가하면 이 표와 [PROJECT_CONTEXT.md §7](../PROJECT_CONTEXT.md#7-코드-지도)의 코드 지도를 함께 고친다.
