# 자금 공고 카탈로그

이 폴더는 운영자가 공식 공고를 정리한 자금·지원 상품을 버전이 고정된 JSON으로 보관한다. 현재 상품은 검수자가 지정되지 않았고 근거 일부가 검색 결과 요약이다([검수 범위](#2026-09-20-검수-범위)). 사용자 화면이나 웹 요청이 외부 공고를 수집하지 않으며, 운영자가 검증·적재 명령을 직접 실행한다.

- `catalog.json`: 현재 카탈로그. `catalogKey` + `catalogVersion`으로 식별하고, 파일 바이트의 SHA-256을 릴리스 checksum으로 쓴다.
- 스키마는 `app/src/features/funding/schema.ts`, 규칙 검사는 `app/src/features/funding/validation.ts`, 후보 판정은 `app/src/features/funding/eligibility.ts`에 있다.

## 운영 명령

```sh
npm --prefix app run funding:validate
npm --prefix app run funding:load
```

- `funding:validate`는 DB 없이 검사 결과만 출력한다. `funding:load`는 같은 검사를 통과한 카탈로그만 적재한다.
- 검사 항목, 오류·주의 구분, 적재·활성화 규칙은 [funding.md](../../../docs/domains/funding.md#카탈로그)에 있다.

## 갱신 절차

1. 공식 기관 원문(기업마당, 중소벤처기업부, 서울시, 서울신보, K-Startup 등)에서 공고명·기관·접수기간·접수 상태·대상 사업단계·지역·용도·업종·금리·한도·상환 조건을 확인한다.
2. 확인한 날짜를 `observedAt`, 사람이 검수한 날짜를 `reviewedAt`, 다음 재확인 날짜를 `nextReviewAt`에 기록한다.
3. 원문에서 확정하지 못한 값은 0이나 추정값으로 채우지 않고 `null` 또는 `UNKNOWN`으로 남기고, 왜 확정할 수 없는지 `unsupportedCalculationReasons`·`additionalChecks`·`note`에 적는다.
4. 조건별로 `evidence`에 공식 URL·문서명·확인일·확인 방법을 남긴다. 지역·용도·업종을 PASS 또는 FAIL로 판정하려면 각각 REGION·PURPOSE·INDUSTRY의 공식 원문 근거가 필요하다. 검색 결과 요약만 확인한 경우 `retrievalMethod`를 `SEARCH_RESULT_SUMMARY`로 기록하며 해당 조건은 UNKNOWN으로 남는다.
5. 내용이 바뀌면 기존 항목을 덮어쓰지 않고 `version`을 올려 새 항목으로 추가하고, 카탈로그 `catalogVersion`도 올린다.
6. `npm --prefix app run funding:validate`로 확인한 뒤 `funding:load`를 실행한다.

## 확정 조건과 상환 계산

- 금리·상환기간·원금 거치를 원문에서 확정 숫자로 확인했을 때만 `interestRateConfirmed`를 true로 두고 `interestRatePercent`(고정 연 금리 %)·`repaymentTermMonths`(전체 상환개월)·`repaymentGraceMonths`(원금 거치개월)를 기록한다. 범위 금리·변동금리는 확정 숫자가 아니므로 `null`로 남긴다.
- `interestCondition`·`repaymentCondition`은 근거를 남기는 문장이며 숫자로 해석하지 않는다.
- `publicLimit`에는 공고의 공개 한도를 적는다. 대출 원금이 아니라 최대 금액 검증용이다.
- 상환 계산 대상이 아닌 대출은 그 사유를 `unsupportedCalculationReasons`에 적는다. 계산 엔진이 지원하는 상환방식은 원리금균등·원금균등이다.
- 이 필드로 상환 계산 대상을 정하는 규칙과 계획의 대출 가정으로 적용하는 절차는 [funding.md](../../../docs/domains/funding.md#판정)에 있다.

## 원본 파일

공고문 PDF 등 원본 파일은 저장소에 추가하지 않는다. URL·파일명·checksum·검수 근거만 남긴다. 원문 파일을 내려받아 보관하지 않았으면 `sourceDocumentRetrieved`는 `false`, `sourceChecksum`은 `null`이다.

## 2026-09-20 검수 범위

- 접수 상태가 CLOSED로 확인된 상품 1건(예비창업패키지 2차), 접수 상태를 확정할 수 없어 UNKNOWN으로 남긴 상품 4건을 기록했다.
- 같은 날 접수 상태가 OPEN으로 확인된 상품은 없어 현재 신청 가능 후보로 확정되는 상품은 0건이다.
- 예비 창업자가 아니라 사업자등록 이후에만 검토할 수 있는 상품 3건(서울시 중소기업육성자금 창업기업자금·포용금융자금·긴급자영업자금)을 별도 상태로 분리했다.
- 2026-09-09에 확인했던 강북창업지원센터 입주 모집은 다시 확인하지 않아 검수 기한 경과 상태로 남겼고, 현재 후보에서 제외된다.
- 서울여성 창업아이디어 공모전 등 2026-09-09 검토 항목은 이번 검수에서 다시 확인하지 않아 카탈로그에 넣지 않았다.
- 검수자(`reviewer`)는 아직 지정되지 않아 `UNASSIGNED`이며, `funding:validate`는 경고로 표시하고 `funding:load`는 그대로 적재한다. 이 상품들은 현재 후보가 아니라 추가 확인으로 분류된다.
- 2026-09-23에 조건별 근거(`evidence`) 추가를 반영해 `catalogVersion`을 `2026-09-23.1`, 상품 버전을 `1.0.1`로 올렸다. 검수 내용과 검수일은 같다.
