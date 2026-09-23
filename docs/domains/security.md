# 웹 요청 보안 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

## 코드 위치

- `app/src/lib/auth.ts`, `session.ts`, `request-security.ts`, `rate-limit.ts`: Better Auth, 세션, 교차 출처·본문 크기 검사, 요청 빈도 제한.

## 웹 요청 보안 경계

- 업무 변경 API는 브라우저의 `Origin`·`Sec-Fetch-Site`를 검사해 교차 출처 세션 요청을 거부한다. JSON 본문 API는 `application/json`과 64 KiB `Content-Length` 상한을 요구한다.
- 계획 생성·수정·삭제, 계산, 자금 후보 조회(페이지·계획 기준), 상품 조건 적용은 사용자별 프로세스 내 요청 빈도 제한을 둔다. 이 제한은 단일 인스턴스 방어선이며, 다중 인스턴스 운영에서는 배포 플랫폼의 공유·엣지 rate limit을 함께 설정해야 한다.
- 모든 경로에 CSP, `nosniff`, 프레임 차단, referrer·카메라·마이크·위치정보 제한 헤더를 적용한다. Next.js 부트스트랩 호환 때문에 현재 CSP의 `script-src`에는 `'unsafe-inline'`이 남아 있으며, nonce 도입 전까지의 명시적 잔여 위험이다.
