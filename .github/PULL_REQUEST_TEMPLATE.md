Closes #<!-- 작업 계약 Issue 번호 -->

## 변경 결과

- 사용자에게 달라지는 점:
- API·DB·데이터·계산 계약 영향:
- migration 또는 운영 데이터 영향:
- 작업 계약과 달라진 범위(없으면 "없음"):

## 검증 증거

- [ ] `git diff --check`
- [ ] 관련 단위 테스트
- [ ] `npm --prefix app run verify:fast`
- [ ] DB 변경 시 `npm --prefix app run verify:db`
- [ ] UI 변경 시 실제 빈 상태·오류·모바일 확인과 `verify:e2e`
- [ ] 병합 후보 `npm --prefix app run verify`

실행한 명령과 결과:

실행하지 못한 검사와 이유:

## AI 사용과 검토

- 사용한 AI 도구와 맡긴 범위:
- 사람이 직접 확인한 파일·동작:
- AI 리뷰 외 인간 리뷰어:

## 데이터와 보안

- 출처·기준일·릴리스·checksum:
- [ ] 비밀값·환경파일·로컬 원본·생성물이 포함되지 않음
- [ ] `null`/0/`UNKNOWN`, 관측값/사용자 가정, 상위/세부 업종 범위를 보존함

## 인수인계

- 알려진 위험:
- 후속 작업(Issue 번호):
- 현재 HEAD:
