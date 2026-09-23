# 자금 카탈로그·후보 도메인

이 도메인을 바꾸는 PR은 코드·테스트와 함께 이 문서를 고친다. 제품 전체의 데이터·계산 계약은 [AGENTS.md §3](../../AGENTS.md#3-데이터계산-계약)을 따른다.

카탈로그 편집·검수 절차와 현재 검수 범위는 [app/catalog/funding/README.md](../../app/catalog/funding/README.md)를 따른다.

## 코드 위치

- `app/src/features/funding`: 자금 공고 카탈로그의 Zod 스키마, 규칙 검사, 고정 조건 판정 함수, 릴리스·상품 버전 적재, 활성 카탈로그 읽기(`read.ts`)와 요청 스키마·응답 조립(`candidates.ts`), 페이지 단위 후보 화면(`FundingMatcher.tsx`)과 두 화면이 함께 쓰는 결과 표시(`FundingCandidatesPanel.tsx`). 판정 함수는 React·DB·외부 API에 의존하지 않는다.
- `app/catalog/funding`: 공식 원문을 확인해 정리한 공고 JSON 카탈로그와 갱신 절차 문서.

## 카탈로그

- 실행: `npm --prefix app run funding:validate`, `npm --prefix app run funding:load [-- --catalog <경로>]`. 기본 카탈로그는 `app/catalog/funding/catalog.json`이다.
- 원문 확인과 카탈로그 편집은 운영자가 수행한다. 웹 요청 처리 중에는 공고 수집이나 카탈로그 적재를 하지 않는다.
- Zod 스키마(`app/src/features/funding/schema.ts`)가 productKey·version 형식, 필수 필드, 날짜 형식, 금액의 원 단위 정수 문자열, supportType·사업단계·접수 상태·상환방식 열거, 공식 기관 HTTPS 호스트, checksum 형식을 검사한다.
- 상환 계산에 쓰는 확정 조건은 자유 서술이 아니라 구조화된 필드로 기록한다: `interestRatePercent`(확정 고정 연 금리 %), `repaymentTermMonths`(전체 상환개월), `repaymentGraceMonths`(원금 거치개월). `interestCondition`·`repaymentCondition`은 근거 문장으로만 남기며 숫자로 해석하지 않는다.
- 규칙 검사(`app/src/features/funding/validation.ts`)가 productKey+version 중복, 접수기간과 관측 접수 상태의 모순(종료된 공고를 OPEN으로 기록 등), 지원 유형과 금리·상환 조건의 모순, 원문 미확보 상태의 checksum, 검수 기한 경과, 상환 계산 사유 누락·불필요, 조건별 공식 근거 누락, 확정 조건의 내부 모순을 검사한다. 검수 기한 경과와 검수자 미지정(UNASSIGNED), 공식 원문이 아닌 요약 근거는 주의로 기록한다. 검수 기능이 생기기 전까지 `funding:load`는 검수자가 UNASSIGNED여도 적재한다. 그런 상품은 판정에서 현재 후보가 되지 않고 추가 확인으로 분류된다.
- 릴리스에는 출처 목록(`sourceDocuments`), 이 카탈로그가 담은 상품 버전 목록(`productVersions`), 기준일(`basisDate`), 상품 검수일 중 가장 늦은 날짜(`reviewedAt`), `schemaVersion`, 카탈로그 checksum, 검증 요약을 함께 보존한다.
- 카탈로그 checksum은 파일 바이트의 SHA-256이다. `funding_catalog_releases.catalogChecksum`이 UNIQUE라서 같은 내용을 다시 적재해도 릴리스가 늘지 않고 `ALREADY_ACTIVE`로 끝난다. 같은 catalogKey+catalogVersion에 다른 내용이 오면 거부한다.
- 상품 버전은 `productKey + version`이 UNIQUE이며 불변이다. 이미 적재된 버전과 내용이 다르면 `PRODUCT_VERSION_IMMUTABLE`로 실패하고 기존 행을 덮어쓰지 않는다. 새 내용은 version을 올려 추가한다. 릴리스와 상품 버전은 `funding_catalog_products` 연결 테이블로 묶어 동일한 불변 버전을 여러 릴리스가 재사용할 수 있다.
- 적재는 PENDING으로 시작해 적재 후 검증까지 통과한 뒤 한 트랜잭션으로 ACTIVE가 된다. 활성화는 상태 전환만 하며 과거 릴리스와 상품 버전을 지우지 않는다.
- 실패하면 이번 적재가 만든 상품 버전만 삭제하고, 이전에 이미 저장된 상품 버전은 그대로 둔다. 릴리스는 `FAILED`와 실패 사유(`오류 코드 + 메시지`)로 남고 기존 ACTIVE 카탈로그는 계속 서비스된다.
- 검증을 우회하는 명령행 옵션은 없다. 조건이 불명확한 상품을 강제로 활성화하는 경로를 만들지 않는다.
- 판정 규칙(`app/src/features/funding/eligibility.ts`): 조건별로 PASS/FAIL/UNKNOWN을 계산하고 FAIL이 하나라도 있으면 FAIL, FAIL 없이 UNKNOWN이 있으면 UNKNOWN, 모두 PASS면 PASS다. REGION·PURPOSE·INDUSTRY를 포함한 각 조건에 직접 확인한 공식 근거가 없으면 UNKNOWN이다. 접수 상태 OPEN/CLOSED/UNKNOWN은 자격 판정과 별도로 유지한다. 검수 기한이 지난 상품, 검수일 또는 검수자가 없는 상품, 검색 결과 요약으로만 확인한 상품은 현재 후보로 확정하지 않는다.
- 지원금·보증·공간·프로그램 지원은 대출 원금이나 상환 일정으로 변환하지 않는다. 대출이라도 공개 한도·확정 금리(`interestRateConfirmed`와 `interestRatePercent`)·상환기간·거치(`repaymentTermMonths`·`repaymentGraceMonths`)·상환방식 중 하나라도 확정되지 않았거나 계산 엔진이 지원하지 않는 방식이거나 거치개월이 전체 상환개월 이상이면 상환 계산 대상으로 표시하지 않고 사유를 남긴다. 확정 조건이 모두 있는 대출은 상환 계산 대상이며, 이때만 상품 조건을 계획의 대출 가정으로 옮길 수 있다.
- 지원 유형 표시: GRANT 지원금, GUARANTEE 보증, LOAN 대출, SPACE 공간·보육, PROGRAM 프로그램. 사업자등록 이후에만 검토할 수 있는 상품은 POST_REGISTRATION 상태로 현재 예비 창업자 후보와 분리한다.

## 후보 조회 API

- `/api/funding/candidates`: 인증된 POST만 제공한다. 활성 릴리스와 `funding_catalog_products`의 position 순서로 불변 상품 버전을 읽고 `evaluateCandidates`로 판정한다. 조회 함수는 `app/src/features/funding/read.ts`, 요청 스키마와 응답 조립은 `app/src/features/funding/candidates.ts`에 있다.
- 요청 본문은 `businessStage`(PRE_REGISTRATION·POST_REGISTRATION·UNKNOWN), `districtCode`(5자리 또는 null), `industryCode`(CS100001 형식 또는 null), `purpose`(기존 Purpose 또는 UNKNOWN)만 받는 `z.strictObject`다. 그 밖의 키는 400 `INVALID_INPUT`으로 거부한다.
- 판정 기준일은 서버의 한국 시간 날짜(`todayInKst`)로 고정한다. 클라이언트가 `asOfDate`를 보내면 400이며, 테스트만 `listFundingCandidates`에 날짜를 주입한다.
- 상태 구분: 미로그인 401 `UNAUTHORIZED`, 잘못된 프로필 400 `INVALID_INPUT`, 활성 카탈로그 릴리스 없음 503 `CATALOG_UNAVAILABLE`. 활성 릴리스가 없을 때 빈 후보가 아니라 503으로 알린다.
- 응답에는 카탈로그 버전·기준일·판정 기준일·검수자·스키마 버전·활성화 시각, 입력 프로필, 상태별 개수, 상품명·기관·지원 유형·후보 상태, 포함·제외·추가 확인 이유, 조건별 PASS/FAIL/UNKNOWN과 근거 id, 공식 링크·접수·검수 상태, 상환 계산 가능 여부와 불가 사유가 담긴다.
- `POST /api/plans/{id}/funding-matches`: 인증된 POST만 제공한다. 요청 본문을 받지 않고 계획에 저장된 조건으로만 판정하며, 판정 기준일은 서버의 한국 시간 오늘(`todayInKst`)로 고정한다. 판정 로직은 새로 만들지 않고 `listFundingCandidates`를 그대로 호출한다.
- 계획 조건 저장: `plans.fundingProfileJson`(nullable JSON)에 사업단계·자치구·업종·용도를 저장한다. 검증은 후보 조회 API의 `fundingCandidateRequestSchema`를 그대로 재사용하고, 재무 계산 입력(`inputJson`)·`INPUT_SCHEMA_VERSION`·`calculationKey`·저장된 결과 스냅샷은 바꾸지 않는다. `POST /api/plans`와 `PUT /api/plans/{id}`에서 선택 항목이며, 보내지 않으면 저장된 조건을 유지하고 `null`이면 비운다. 조건이 없는 기존 계획은 그대로 유효하다. 계획 화면은 네 조건을 하나도 입력하지 않으면 UNKNOWN 프로필 대신 `null`을 보내므로, 조건 없이 저장한 계획의 후보 조회는 400이고 사용자가 저장된 조건을 비울 수 있다.
- 계획 조건 판정 상태: 미로그인 401 `UNAUTHORIZED`, 없거나 타인 소유인 계획 404 `NOT_FOUND`(소유자 불일치를 403으로 구분하지 않는다), 저장된 조건이 없거나 스키마와 다르면 400 `INVALID_INPUT`, 활성 카탈로그 릴리스가 없으면 503 `CATALOG_UNAVAILABLE`.
- 판정 응답은 후보 조회 응답에 어느 계획·revision의 조건이었는지(`plan.id`, `plan.revision`)를 더한다. 자금 후보는 조회 결과이며 불변 저장 대상이 아니다.

## 상품 확정 조건 → 대출 가정 적용

- 상품 확정 조건을 계획의 신규 대출 가정으로 옮기는 일은 사용자가 계획 화면에서 명시적으로 실행할 때만 일어난다. 후보 조회·판정·계획 불러오기·초안 저장 시점에는 신규 대출 입력을 자동으로 채우지 않는다. 화면은 상품 확정 조건과 사용자가 입력한 가정을 구분해 표시한다.
- 적용 대상은 서버가 저장된 계획 조건으로 다시 판정한 `CURRENT_CANDIDATE`이면서 `assessProductRepayment(...).supported === true`인 대출 상품뿐이다. 지원금·보증·공간·프로그램 지원과 공개 한도 없음·금리 미확정·상환방식 미지원·상환기간·거치 미확인 상품은 "상환 계산 대상 아님 + 사유"를 유지하며 0원 상환으로 대체하지 않는다.
- 실행: `POST /api/plans/{planId}/loan-assumption`(본문 `{ productKey, version, revision }`). 서버가 활성 카탈로그에서 상품 버전과 현재 후보 여부를 다시 확인하고, 사용자가 초안에 저장한 `newLoan.principal`에 상품의 확정 금리·기간·거치·상환방식만 결합한다. 공개 한도는 최대 금액 검증에만 쓰며 신청·승인 원금으로 자동 대입하지 않는다. 계산은 재무 계산 엔진(`app/src/features/finance`)을 그대로 쓰며 새 계산기나 별도 상환표를 만들지 않는다.
- 적용은 계획 입력의 변경이므로 기존 revision·불변 결과 규칙을 따른다. 성공하면 revision이 1 증가하고, 적용 전에 계산해 둔 과거 `plan_results`는 바뀌지 않는다.
- 출처 보존: 적용 시 `plans.loanAssumptionJson`에 상품 키·버전·상품명·카탈로그 키·카탈로그 버전·적용 시각과 실제 신규 대출 입력을 저장한다. 계산 시 그 값을 `plan_results.loanAssumptionJson`으로 복사해, 그 뒤 카탈로그가 바뀌어도 어떤 상품 조건이 반영된 결과인지 추적할 수 있다.
- 출처 삭제: 계획 저장(PUT)에서 새 `newLoan` 입력이 저장된 상품 확정 조건과 값까지 같으면 출처를 유지하고, 사용자가 값을 직접 바꾸면 출처를 지운다. 상품 조건이 아닌 값을 상품 조건으로 표시하지 않기 위해서다.
- 상태 구분: 미로그인 401 `UNAUTHORIZED`, 없거나 타인 소유인 계획 404 `NOT_FOUND`, 잘못된 본문·활성 카탈로그에 없는 상품 버전·상환 계산 대상이 아닌 상품 400 `INVALID_INPUT`, 활성 카탈로그 없음 503 `CATALOG_UNAVAILABLE`, 오래된 revision 409 `REVISION_CONFLICT`.
- 화면 규칙: 계획이 저장되어 있고 자금 조건·재무 입력에 저장하지 않은 변경이 없을 때만 적용할 수 있다. 적용 뒤에는 어떤 상품 버전·카탈로그의 조건인지와 승인 확정이 아님을 함께 표시한다.

## 테스트

테스트는 카탈로그 스키마·규칙 위반·조건 판정·상환 계산 가능 여부를 DB 없이 검증하고, 실제 카탈로그 5건이 규칙을 통과하는지도 확인한다. 카탈로그 적재와 후보 조회 테스트만 `TEST_DATABASE_URL` 전용 DB를 사용하며, 검수자를 지정한 합성 카탈로그와 검수자 미지정(UNASSIGNED) 카탈로그가 ACTIVE로 적재되는지 확인한 뒤 실행 중 만든 릴리스와 상품 버전을 삭제하고 실행 전 ACTIVE 상태를 복원한다. 활성 릴리스가 하나뿐이라 이 테스트 파일들은 같은 테스트 DB에서 ACTIVE 상태를 서로 바꾸지 않도록 Vitest `fileParallelism: false`로 파일 단위 순차 실행한다. 후보 API 테스트는 미로그인 401, 잘못된 프로필 400, 활성 카탈로그 없음 503, position 순서, PASS/FAIL/UNKNOWN 조합, UNASSIGNED·CLOSED·REVIEW_OVERDUE·POST_REGISTRATION 분리, 후보 0건, 비(非)대출 상환 미노출, 판정 기준일 주입을 확인한다. 계획 조건 테스트는 계획 생성·수정의 조건 저장과 보존(키가 없으면 저장된 조건 유지), 미로그인 401, 소유자 간 404, 조건 없는 계획 400, 활성 카탈로그 없음 503, 저장된 조건으로 정상 판정, 조건 수정이 다음 조회에 반영되는지를 확인한다.

상품 조건 적용 테스트는 사용자가 저장한 원금과 상품 확정 조건의 결합, 공개 한도 초과·0원 원금·현재 후보가 아닌 상품 거부, 금리 0·거치 0과 전체기간 이상, 원금균등·원리금균등의 원금 합계와 최종 잔액, 원 단위 반올림을 확인한다. 미확정 상품과 지원금·보증·공간·프로그램을 제외하고, 실제 카탈로그 5건의 `supported=false` 고정, 적용 API의 401·404·400·503·409, 상품 출처의 저장·결과 복사·직접 수정 시 삭제, 적용 뒤 revision 증가와 과거 결과 불변성도 검증한다.
