# Architecture Decision Records

코드만 보고 되돌리기 어려운 결정을 짧은 ADR로 남긴다. 다음 변경은 ADR 대상이다.

- 기술 스택이나 런타임 추가·교체
- DB 모델의 소유권·불변성·삭제 정책 변경
- 공개 API 계약이나 상태 의미 변경
- 데이터 출처·집계 범위·계산 해석 변경
- 인증·권한·비밀관리 경계 변경
- 현재 보류 기능을 제품 범위로 편입

사소한 구현 선택, 쉽게 되돌릴 수 있는 리팩터링, 개별 버그 수정은 ADR 대상이 아니다.

## 작성 규칙

1. 파일명은 `NNNN-short-kebab-title.md`다.
2. 상태는 `Proposed`, `Accepted`, `Superseded`, `Rejected` 중 하나다.
3. 결정 전에 대안과 데이터·운영 영향을 기록한다.
4. 승인된 ADR의 후속 코드·migration·문서 PR을 연결한다.
5. 결정을 바꿀 때 과거 ADR을 수정해 역사를 지우지 않고 새 ADR에서 `Supersedes`로 연결한다.

[0000-template.md](0000-template.md)를 복사해 사용한다. 현재 제품 사실은 ADR이 아니라 [PRODUCT.md](../PRODUCT.md)와 도메인 문서에 유지한다.
