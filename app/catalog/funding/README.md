# 자금 공고 카탈로그

이 폴더는 운영자가 공식 공고를 정리한 자금·지원 상품을 버전이 고정된 JSON으로 보관한다. 운영자가 검증·적재 명령을 직접 실행한다. 현재 카탈로그의 확인 범위는 [확인 범위](#2026-09-20-확인-범위)에 있다.

- `catalog.json`: 현재 카탈로그. `catalogKey` + `catalogVersion`으로 식별하고, 파일 바이트의 SHA-256을 릴리스 checksum으로 쓴다.
- 스키마는 `app/src/features/funding/schema.ts`, 규칙 검사는 `app/src/features/funding/validation.ts`, 맞춰 보기는 `app/src/features/funding/matching.ts`에 있다.

## 운영 명령

```sh
npm --prefix app run funding:validate
npm --prefix app run funding:load
```

- `funding:validate`는 DB 없이 검사 결과만 출력한다. `funding:load`는 같은 검사를 통과한 카탈로그만 적재한다.
- 자동 수집 출처가 있으면 `funding:load` 대신 `npm --prefix app run funding:sync`로 이 카탈로그와 자동 상품을 합쳐 적재한다. `funding:load`로 이 파일만 적재하면 자동 상품이 빠진 릴리스가 ACTIVE가 된다.
- 검사 항목, 오류·주의 구분, 적재·활성화 규칙은 [funding.md](../../../docs/domains/funding.md#카탈로그)에 있다.

## 갱신 절차

1. 공식 기관 원문(기업마당, 중소벤처기업부, 서울시, 서울신보, K-Startup 등)에서 공고명·기관·접수기간·접수 상태·대상 사업단계·지역·용도·업종·금리·한도·상환 조건을 확인한다.
2. 확인한 날짜를 `observedAt`에 기록하고 `origin`은 `OPERATOR`로 둔다. 검수자·검수일·다음 검토일은 적지 않는다(v1.5.0에서 없앴다, [ADR 0009](../../../docs/decisions/0009-funding-ai-condition-extraction.md) §7).
3. 원문에서 확정하지 못한 값은 0이나 추정값으로 채우지 않고 `null` 또는 `UNKNOWN`으로 남기고, 왜 확정할 수 없는지 `unsupportedCalculationReasons`·`additionalChecks`·`note`에 적는다. 지원 유형을 확인하지 못했으면 `supportType`을 `UNKNOWN`, 신청 가능한 사업 단계를 확인하지 못했으면 `eligibleBusinessStages`를 빈 배열로 둔다.
4. 조건별로 `evidence`에 공식 URL·문서명·확인일·확인 방법을 남긴다. 지역·용도·업종을 미확인이 아닌 값으로 기록하려면 각각 REGION·PURPOSE·INDUSTRY 근거가 있어야 한다(규칙 검사). 검색 결과 요약만 확인한 경우 `retrievalMethod`를 `SEARCH_RESULT_SUMMARY`로 기록한다. 규칙 검사는 이를 주의로 알리고, 맞춰 보기는 그 조건을 운영자 확인 값으로 쓰지 않는다. 맞춰 보기는 사업 단계·지역에 공식 원문(검색 결과 요약이 아닌) 근거가 있을 때만 운영자 확인 값으로 쓴다.
5. 내용이 바뀌면 기존 항목을 덮어쓰지 않고 `version`을 올려 새 항목으로 추가하고, 카탈로그 `catalogVersion`도 올린다.
6. `npm --prefix app run funding:validate`로 확인한 뒤 `funding:load`를 실행한다.

## 확정 조건과 상환 계산

- 금리·상환기간·원금 거치를 원문에서 확정 숫자로 확인했을 때만 `interestRateConfirmed`를 true로 두고 `interestRatePercent`(고정 연 금리 %)·`repaymentTermMonths`(전체 상환개월)·`repaymentGraceMonths`(원금 거치개월)를 기록한다. 범위 금리·변동금리는 확정 숫자가 아니므로 `null`로 남긴다.
- `interestCondition`·`repaymentCondition`은 근거를 남기는 문장이며 숫자로 해석하지 않는다.
- `publicLimit`에는 공고의 공개 한도를 적는다. 대출 원금이 아니라 최대 금액 검증용이다.
- 상환 계산 대상이 아닌 대출은 그 사유를 `unsupportedCalculationReasons`에 적는다. 계산 엔진이 지원하는 상환방식은 원리금균등·원금균등이다.
- 이 필드로 상환 계산 대상을 정하는 규칙은 [funding.md](../../../docs/domains/funding.md#카탈로그)에 있다. 상품 조건을 계획의 대출 가정으로 옮기는 기능은 없다([ADR 0009](../../../docs/decisions/0009-funding-ai-condition-extraction.md) §5).

## 원본 파일

공고문 PDF 등 원본 파일은 저장소에 추가하지 않는다. URL·파일명·checksum·확인 근거만 남긴다. 원문 파일을 내려받아 보관하지 않았으면 `sourceDocumentRetrieved`는 `false`, `sourceChecksum`은 `null`이다.

## 2026-09-20 확인 범위

현재 카탈로그 `2026-11-04.1`(상품 버전 `1.0.2`)에 적용되는 확인 내용이다. `2026-09-28.1`은 `2026-09-23.1`에서 스키마를 v1.1.0으로 올리고 자동화 설정을 더한 것이고, `2026-09-28.2`는 스키마를 v1.2.0으로, `2026-11-03.1`은 v1.3.0으로, `2026-11-03.2`는 v1.4.0으로 올린 것이다. `2026-11-04.1`은 v1.5.0으로 올리며 검수자·검수일·다음 검토일을 지우고 출처 구분(`origin`)을 더해 상품 버전을 `1.0.2`로 올렸다. 상품의 조건과 근거는 같다.

- 접수 상태가 CLOSED로 확인된 상품 1건(예비창업패키지 2차), 접수 상태를 확정할 수 없어 UNKNOWN으로 남긴 상품 4건을 기록했다.
- 같은 날 접수 상태가 OPEN으로 확인된 상품은 없다.
- 예비 창업자가 아니라 사업자등록 이후에만 신청할 수 있는 상품 3건(서울시 중소기업육성자금 창업기업자금·포용금융자금·긴급자영업자금)은 사업 단계를 사업자등록 이후로 기록했다.
- 2026-09-09에 확인했던 강북창업지원센터 입주 모집은 다시 확인하지 않았다(확인일 2026-09-09). 맞춰 보기 카드는 이 기록일을 보여 준다.
- 서울여성 창업아이디어 공모전 등 2026-09-09 검토 항목은 2026-09-20에 다시 확인하지 않아 카탈로그에 넣지 않았다.
- 근거 일부는 공식 원문이 아니라 검색 결과 요약이다.

## 자동화 설정

`catalog.json`의 `automation`은 funding:sync가 모은 자동 상품에만 적용된다. 규칙은 [funding.md](../../../docs/domains/funding.md#동기화)와 [ADR 0006](../../../docs/decisions/0006-funding-discovery-automation.md)에 있다.

- `blockedSources`: 맞춰 보기에서 보여 주지 않을 자동 상품(운영자 숨김, ADR 0009 §6). `{ "source": "SEMAS_OLS", "externalId": "…", "reason": "…" }`처럼 출처·식별자·사유를 적는다.
- `sourceSyncs`: funding:sync가 채운다. 이 파일에는 비워 둔다.
- 자동 상품(`origin`이 `SYNC`)은 이 파일에 넣지 않는다. funding:sync가 거부한다. 같은 공고를 사람이 기록하려면 그 상품에 `sourceRef`를 적는다. 그러면 사람 기록이 자동 상품보다 우선한다.
