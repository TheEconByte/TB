# 자금 카탈로그·후보 도메인

이 문서는 카탈로그 검증·적재, 판정, API 정책을 다룬다. 카탈로그 편집 절차, 필드 기록 규칙, 현재 검수 범위는 [app/catalog/funding/README.md](../../app/catalog/funding/README.md)에 있다.

## 코드 위치

- `app/src/features/funding`: 판정 함수는 React·DB·외부 API에 의존하지 않는다.
  - 카탈로그 Zod 스키마(`schema.ts`), 규칙 검사(`validation.ts`), 고정 조건 판정(`eligibility.ts`)
  - 릴리스·상품 버전 적재, 활성 카탈로그 읽기(`read.ts`), 요청 스키마·응답 조립(`candidates.ts`)
  - 페이지 단위 후보 화면(`FundingMatcher.tsx`), 두 화면이 함께 쓰는 결과 표시(`FundingCandidatesPanel.tsx`)
- `app/catalog/funding`: 운영자가 공식 공고를 정리한 JSON 카탈로그와 갱신 절차 문서.

## 카탈로그

- 실행: `npm --prefix app run funding:validate`, `npm --prefix app run funding:load [-- --catalog <경로>]`. 기본 카탈로그는 `app/catalog/funding/catalog.json`이다.
- 원문 확인과 카탈로그 편집은 운영자가 수행한다.
- Zod 스키마가 productKey·version 형식, 필수 필드, 날짜 형식, 금액의 원 단위 정수 문자열, supportType·사업단계·접수 상태·상환방식 열거, 공식 기관 HTTPS 호스트, checksum 형식을 검사한다.
- 상환 계산은 구조화된 확정 조건 필드(`interestRatePercent`·`repaymentTermMonths`·`repaymentGraceMonths`)만 읽는다. 조건 문장(`interestCondition`·`repaymentCondition`)은 숫자로 해석하지 않는다. 기록 규칙은 카탈로그 README의 "확정 조건과 상환 계산"에 있다.
- 규칙 검사 항목:
  - productKey+version 중복
  - 접수기간과 관측 접수 상태의 모순(종료된 공고를 OPEN으로 기록 등)
  - 지원 유형과 금리·상환 조건의 모순, 확정 조건의 내부 모순
  - 원문 미확보 상태의 checksum
  - 검수 기한 경과
  - 상환 계산 사유 누락·불필요, 조건별 공식 근거 누락
- 다음은 오류가 아니라 주의로 기록한다: 검수 기한 경과, 검수자 미지정(UNASSIGNED), 공식 원문이 아닌 요약 근거, 신청기간 종료일 전의 CLOSED 기록(조기 마감이면 근거를 추가한다).
- 검수 기능이 생기기 전까지 `funding:load`는 검수자가 UNASSIGNED여도 적재한다. 그런 상품은 판정에서 현재 후보가 되지 않고 추가 확인으로 분류된다.
- 검증을 우회하는 명령행 옵션은 없다. 조건이 불명확한 상품을 강제로 활성화하는 경로를 만들지 않는다.

### 릴리스와 상품 버전

- 릴리스에는 출처 목록(`sourceDocuments`), 이 카탈로그가 담은 상품 버전 목록(`productVersions`), 기준일(`basisDate`), 상품 검수일 중 가장 늦은 날짜(`reviewedAt`), `schemaVersion`, 카탈로그 checksum, 검증 요약을 함께 보존한다.
- 카탈로그 checksum은 파일 바이트의 SHA-256이다. `funding_catalog_releases.catalogChecksum`이 UNIQUE라서 같은 내용을 다시 적재해도 릴리스가 늘지 않고 `ALREADY_ACTIVE`로 끝난다. 같은 catalogKey+catalogVersion에 다른 내용이 오면 거부한다.
- 상품 버전(`funding_product_versions`)은 `productKey + version`이 UNIQUE이며 불변이다.
  - 이미 적재된 버전과 내용이 다르면 `PRODUCT_VERSION_IMMUTABLE`로 실패하고 기존 행을 덮어쓰지 않는다. 새 내용은 version을 올려 추가한다.
  - 릴리스와 상품 버전은 `funding_catalog_products` 연결 테이블로 묶어, 같은 불변 버전을 여러 릴리스가 재사용할 수 있다.
- 적재는 PENDING으로 시작해 적재 후 검증까지 통과한 뒤 한 트랜잭션으로 ACTIVE가 된다. 활성화는 상태 전환만 하며 과거 릴리스와 상품 버전을 지우지 않는다.
- 실패하면 이번 적재가 만든 상품 버전만 삭제하고, 이전에 이미 저장된 상품 버전은 그대로 둔다. 릴리스는 `FAILED`와 실패 사유(`오류 코드 + 메시지`)로 남는다.

### 판정

- 판정 규칙(`eligibility.ts`): 조건별로 PASS/FAIL/UNKNOWN을 계산한다. FAIL이 하나라도 있으면 FAIL, FAIL 없이 UNKNOWN이 있으면 UNKNOWN, 모두 PASS면 PASS다.
- REGION·PURPOSE·INDUSTRY를 포함한 각 조건에 직접 확인한 공식 근거가 없으면 UNKNOWN이다.
- 접수 상태 OPEN/CLOSED/UNKNOWN은 자격 판정과 별도로 유지한다.
- 검수 기한이 지난 상품, 검수일 또는 검수자가 없는 상품, 검색 결과 요약으로만 확인한 상품은 현재 후보로 확정하지 않는다.
- 사업자등록 이후에만 검토할 수 있는 상품은 POST_REGISTRATION 상태로 현재 예비 창업자 후보와 분리한다.
- 지원 유형 표시: GRANT 지원금, GUARANTEE 보증, LOAN 대출, SPACE 공간·보육, PROGRAM 프로그램.
- 지원금·보증·공간·프로그램 지원은 대출 원금이나 상환 일정으로 변환하지 않는다.
- 대출의 상환 계산 대상 여부:
  - 공개 한도, 확정 금리(`interestRateConfirmed`와 `interestRatePercent`), 상환기간·거치(`repaymentTermMonths`·`repaymentGraceMonths`), 상환방식이 모두 확정되고, 계산 엔진이 지원하는 방식이며, 거치개월이 전체 상환개월보다 작아야 상환 계산 대상이다.
  - 하나라도 어긋나면 상환 계산 대상으로 표시하지 않고 사유를 남긴다.
  - 상환 계산 대상일 때만 상품 조건을 계획의 대출 가정으로 옮길 수 있다.

## 후보 조회 API

- `/api/funding/candidates`: 인증된 POST만 제공한다. 활성 릴리스와 `funding_catalog_products`의 position 순서로 불변 상품 버전을 읽고 `evaluateCandidates`로 판정한다.
- 요청 본문은 `z.strictObject`로 다음 네 키만 받는다. 그 밖의 키는 400 `INVALID_INPUT`이다.
  - `businessStage`(PRE_REGISTRATION·POST_REGISTRATION·UNKNOWN)
  - `districtCode`(5자리 또는 null)
  - `industryCode`(CS100001 형식 또는 null)
  - `purpose`(기존 Purpose 또는 UNKNOWN)
- 판정 기준일은 서버의 한국 시간 날짜(`todayInKst`)로 고정한다. 클라이언트가 `asOfDate`를 보내면 400이며, 테스트만 `listFundingCandidates`에 날짜를 주입한다.
- 상태 구분: 미로그인 401 `UNAUTHORIZED`, 잘못된 프로필 400 `INVALID_INPUT`, 활성 카탈로그 릴리스 없음 503 `CATALOG_UNAVAILABLE`. 활성 릴리스가 없을 때 빈 후보가 아니라 503으로 알린다.
- 응답에 담는 것:
  - 카탈로그 버전·기준일·판정 기준일·검수자·스키마 버전·활성화 시각, 입력 프로필, 상태별 개수
  - 상품명·기관·지원 유형·후보 상태, 포함·제외·추가 확인 이유
  - 조건별 PASS/FAIL/UNKNOWN과 근거 id, 공식 링크·접수·검수 상태
  - 상환 계산 가능 여부와 불가 사유

### 계획에 저장한 조건으로 판정

- `POST /api/plans/{id}/funding-matches`: 인증된 POST만 제공한다. 요청 본문을 받지 않고 계획에 저장된 조건으로만 판정하며, 판정 기준일은 서버의 한국 시간 오늘(`todayInKst`)로 고정한다. 판정 로직은 새로 만들지 않고 `listFundingCandidates`를 그대로 호출한다.
- 계획 조건 저장: `plans.fundingProfileJson`(nullable JSON)에 사업단계·자치구·업종·용도를 저장한다.
  - 검증은 후보 조회 API의 `fundingCandidateRequestSchema`를 그대로 재사용한다.
  - 재무 계산 입력(`inputJson`)·`INPUT_SCHEMA_VERSION`·`calculationKey`·저장된 결과 스냅샷은 바꾸지 않는다.
  - `POST /api/plans`와 `PUT /api/plans/{id}`에서 선택 항목이다. 보내지 않으면 저장된 조건을 유지하고 `null`이면 비운다. 조건이 없는 기존 계획은 그대로 유효하다.
  - 계획 화면은 네 조건을 하나도 입력하지 않으면 UNKNOWN 프로필 대신 `null`을 보낸다. 그래서 조건 없이 저장한 계획의 후보 조회는 400이고, 사용자가 저장된 조건을 비울 수 있다.
- 상태 구분: 미로그인 401 `UNAUTHORIZED`, 없거나 타인 소유인 계획 404 `NOT_FOUND`(소유자 불일치를 403으로 구분하지 않는다), 저장된 조건이 없거나 스키마와 다르면 400 `INVALID_INPUT`, 활성 카탈로그 릴리스가 없으면 503 `CATALOG_UNAVAILABLE`.
- 판정 응답은 후보 조회 응답에 어느 계획·revision의 조건이었는지(`plan.id`, `plan.revision`)를 더한다. 자금 후보는 조회 결과이며 불변 저장 대상이 아니다.

## 상품 확정 조건 → 대출 가정 적용

- 상품 확정 조건을 계획의 신규 대출 가정으로 옮기는 일은 사용자가 계획 화면에서 명시적으로 실행할 때만 일어난다. 후보 조회·판정·계획 불러오기·초안 저장 시점에는 신규 대출 입력을 자동으로 채우지 않는다. 화면은 상품 확정 조건과 사용자가 입력한 가정을 구분해 표시한다.
- 적용 대상은 서버가 저장된 계획 조건으로 다시 판정한 `CURRENT_CANDIDATE`이면서 `assessProductRepayment(...).supported === true`인 대출 상품뿐이다. 그 밖의 상품은 "상환 계산 대상 아님 + 사유"를 유지하며 0원 상환으로 대체하지 않는다.
- 실행: `POST /api/plans/{planId}/loan-assumption`(본문 `{ productKey, version, revision }`).
  - 서버가 활성 카탈로그에서 상품 버전과 현재 후보 여부를 다시 확인한다.
  - 사용자가 초안에 저장한 `newLoan.principal`에 상품의 확정 금리·기간·거치·상환방식만 결합한다.
  - 저장된 원금이 1원 이상이고 공개 한도 이하인지 확인한다. 공개 한도는 이 검증에만 쓰며 신청·승인 원금으로 자동 대입하지 않는다.
  - 계산은 재무 계산 엔진(`app/src/features/finance`)을 그대로 쓰며 새 계산기나 별도 상환표를 만들지 않는다.
- 적용은 계획 입력의 변경이므로 기존 revision·불변 결과 규칙을 따른다. 성공하면 revision이 1 증가하고, 적용 전에 계산해 둔 과거 `plan_results`는 바뀌지 않는다.
- 출처 보존: 적용 시 `plans.loanAssumptionJson`에 상품 키·버전·상품명·카탈로그 키·카탈로그 버전·적용 시각과 실제 신규 대출 입력을 저장한다. 계산 시 그 값을 `plan_results.loanAssumptionJson`으로 복사해, 그 뒤 카탈로그가 바뀌어도 어떤 상품 조건이 반영된 결과인지 추적할 수 있다.
- 출처 삭제: 계획 저장(PUT)에서 새 `newLoan` 입력이 저장된 상품 확정 조건과 값까지 같으면 출처를 유지하고, 사용자가 값을 직접 바꾸면 출처를 지운다. 상품 조건이 아닌 값을 상품 조건으로 표시하지 않기 위해서다.
- 상태 구분: 미로그인 401 `UNAUTHORIZED`, 없거나 타인 소유인 계획 404 `NOT_FOUND`, 잘못된 본문·활성 카탈로그에 없는 상품 버전·상환 계산 대상이 아닌 상품 400 `INVALID_INPUT`, 활성 카탈로그 없음 503 `CATALOG_UNAVAILABLE`, 오래된 revision 409 `REVISION_CONFLICT`.
- 화면 규칙: 계획이 저장되어 있고 자금 조건·재무 입력에 저장하지 않은 변경이 없을 때만 적용할 수 있다. 적용 뒤에는 어떤 상품 버전·카탈로그의 조건인지와 승인 확정이 아님을 함께 표시한다.

## 테스트

- DB 없이: 카탈로그 스키마·규칙 위반, 실제 카탈로그 5건의 규칙 통과, 조건 판정, 상환 계산 가능 여부, 상품 조건과 사용자 원금의 결합. 후보 조회·계획 조건 판정·상품 조건 적용 API의 경계(상태 코드)는 Prisma를 mock해 DB 없이 검증한다.
- `TEST_DATABASE_URL` 전용 DB: 카탈로그 적재, 실제 DB에서의 후보 조회·계획 조건 판정·상품 조건 적용, 출처 저장과 과거 결과 불변성. 합성 카탈로그만 만들고 끝나면 지우며 실행 전 ACTIVE 상태를 복원한다. 실제 카탈로그 5건이 모두 상환 계산 대상이 아님(`supported=false`)을 확인하는 테스트도 이 묶음 안에 있어 전용 DB가 있을 때만 실행된다.
