# 서울시 상권 도메인

## 코드 위치

- `app/src/features/market`: 서울 열린데이터광장 Open API 수신(`seoul-api.ts`)과 검증본 ZIP·CSV·DBF 파싱, 릴리스 적재·활성화, 공개 조회. 순수 파싱·검증 함수는 React·DB에 의존하지 않는다.

## 적재

- 실행: `npm --prefix app run market:load [-- --from <YYYYQ>] [--to <YYYYQ>]`. 기본은 서울 열린데이터광장 Open API(`app/.env.local`의 `SEOUL_OPEN_API_KEY`)에서 2021년 1분기(API의 첫 분기)부터 매출·점포가 모두 있는 최신 분기까지 받는다([ADR 0003](../decisions/0003-seoul-market-open-api.md), [ADR 0008](../decisions/0008-market-survival-score.md)). 2021~2023년 분기도 현재 영역 코드로 제공된다.
- API 서비스는 영역 `TbgisTrdarRelm`, 추정매출 `VwsmTrdarSelngQq`, 점포 `VwsmTrdarStorQq`다. 분기마다 1,000행씩 받아 받은 행 수가 전체 건수와 같은지 확인한다. 받는 중 전체 건수가 바뀌거나, 요청한 분기가 비어 있거나, 응답 필드 구성이 기록과 다르면 적재하지 않는다.
- API 출처는 서비스별 행 수와 행 순서와 무관한 내용 해시로 남고, 분기별 행 수·해시는 검증 요약(`sourceQuarters`)에 남는다. 로그와 오류는 인증키를 가린다.
- `--source-dir <경로>`는 2026-09-09에 검증한 ZIP 원본을 적재한다.
- 파일 적재는 인코딩(ZIP 안 CSV는 CP949, 영역 DBF 속성은 `.cpg`가 선언한 UTF-8), 예상 헤더 집합, 상권·업종·자치구 코드 형식, 분기 형식(`YYYYQ`), 키 누락·중복, 음수 금액, 파일 크기와 SHA-256을 검사한다.
- 2024년과 2025년 파일은 헤더가 다르므로 `app/src/features/market/headers.ts`의 명시적 매핑을 쓴다. 열 순서가 아니라 열 이름으로 위치를 찾는다. API 필드도 같은 파일의 매핑(`SALES_API_FIELDS` 등)을 쓴다.
- 적재 스키마·정의 버전과 원본 내용(API는 행 내용 해시, 파일은 파일 checksum)으로 릴리스 키를 만든다. 그래서 같은 내용이면 어느 PC에서나 같은 키가 된다. 릴리스 키가 같고 이미 ACTIVE면 쓰기 없이 `ALREADY_ACTIVE`로 끝난다.
- 결합 키는 표시명이 아니라 `quarter + areaType + areaCode + industryCode`다.
- 새 릴리스는 `PENDING`으로 적재하고 적재 후 검증까지 통과한 뒤 한 트랜잭션으로 활성화한다. 활성화는 상태 전환만 하며 이전 릴리스의 행은 지우거나 고치지 않는다.
- 실패하면 새 릴리스의 상권·분기 행을 삭제하고 릴리스를 `FAILED`와 실패 사유로 남긴다.
- 처음 노출하는 업종은 한식(CS100001), 커피·음료(CS100010)다. 다른 업종은 `industries`에 원천 분류로만 남기고 조회를 거부한다.
- 상권 표시명 우선순위: 영역 파일 명칭 → 매출·점포 파일 관측 명칭. 업종 표시명 우선순위: 제품 문서 표시명 → 원천 명칭. 두 명칭은 응답에 함께 담는다.
- 파일 적재는 manifest에 기록된 파일 크기와 SHA-256이 일치하는 원본만 허용한다. 새 원본은 입수일·기준기간·checksum·예상 행 수를 검증해 새 manifest와 정의 버전으로 추가하며, 명령행 옵션으로 검증을 우회하지 않는다.
- 업종 메타데이터는 릴리스별로 저장한다. PENDING·FAILED 릴리스의 업종 원본 명칭이 현재 ACTIVE 릴리스 응답을 바꾸지 않는다.

## 공개 API

- `/api/industries`: 로그인 없이 지원 업종과 현재 활성 릴리스를 반환한다. 활성 릴리스가 없어도 200이며 `activeRelease`가 null이다.
- `/api/markets/areas?districtCode=...`: 자치구 목록은 항상 반환하고, `districtCode`가 있으면 그 자치구의 상권을 반환한다. 없는 자치구 코드는 400 `INVALID_DISTRICT_CODE`다.
- `/api/markets/summary?areaCode=...&industryCode=...[&areaType=...]`: 가용 분기를 오래된 순으로, 분기별 원본 지표를 반환한다. 매출 원값은 원 단위 정수 문자열이고 점포 수는 숫자다.
- `/api/markets/report?areaCode=...&industryCode=...[&areaType=...]`: summary에 상위 업종 집계 범위, 기준분기, 요일·시간대·성별·연령별 원본 구성을 더한다.
- 상태 구분: 활성 릴리스 없음 503 `RELEASE_UNAVAILABLE`, 형식 오류 400 `INVALID_AREA_CODE`·`INVALID_INDUSTRY_CODE`, 없는 상권 404 `AREA_NOT_FOUND`, 같은 코드가 여러 상권 구분에 있으면 400 `AMBIGUOUS_AREA_CODE`, 원천에 있으나 미지원 업종은 400 `UNSUPPORTED_INDUSTRY`다.
- 자료가 없는 조합은 0이 아니라 `dataStatus: NOT_PROVIDED`와 빈 `quarters`로, 매출만 없는 분기는 `salesStatus: NOT_PROVIDED`와 `salesAmount: null`로 응답한다.
- 응답에는 지표 정의(원본 열·단위·해석 제한)와 제한 문구, 릴리스 출처·기준기간·입수일·파일별 SHA-256을 함께 담는다.

## 상권 생존점수

정의와 근거는 [ADR 0008](../decisions/0008-market-survival-score.md)에 있다.

- 코드: `app/src/features/market/score`. 변수·라벨(`dataset.ts`), 로지스틱 회귀(`logistic.ts`), 학습·기준선 비교(`train.ts`), 점수 생성(`build.ts`), 점수 릴리스 적재(`loader.ts`), 공개 API 조립(`api.ts`), 화면(`ScorePanel.tsx`, `MarketGradeBanner.tsx`), `/`로 넘기는 상권 참조(`handoff.ts`). 모델 설정은 `config.ts` 하나에 있다.
- 학습: `npm --prefix app run score:train [-- --version <버전>]`. ACTIVE 상권 릴리스로 업종별 모델을 학습하고 `app/models/market-score/<버전>.json`(계수)과 `<버전>.report.md`(학습 리포트)를 만든다. 같은 버전 파일은 덮어쓰지 않는다. 계수 파일과 리포트는 Git에 포함한다.
- 점수 적재: `npm --prefix app run score:build [-- --model <계수 파일>]`. 기본은 `app/models/market-score`의 이름순 마지막 계수 파일이다. 최신 기준분기의 모든 상권 × 제공 업종 행을 `PENDING`으로 저장하고 행 수·점수 범위를 검증한 뒤 한 트랜잭션으로 활성화한다. 실패하면 행을 지우고 `FAILED`로 남기며 기존 ACTIVE를 유지한다. 계수 파일 checksum·상권 릴리스 키·기준분기가 같으면 `ALREADY_ACTIVE`다. 상권을 다시 적재하면 `score:build`를 다시 실행한다.
- 테스트 AUC가 0.6 미만인 업종은 행을 만들지 않고 요약에 미지원으로 남긴다.
- `/api/markets/score?areaCode=...&industryCode=...[&areaType=...]`(로그인 불필요): 활성 점수 릴리스가 없으면 503 `SCORE_UNAVAILABLE`, 형식 오류는 400, 점수 릴리스의 상권 영역에 없으면 404 `AREA_NOT_FOUND`다. 그 밖에는 200과 `status`(`OK`·`INSUFFICIENT_STORES`·`UNSUPPORTED_INDUSTRY`·`NO_DATA`), 상태 문구, 점수·등급·순위·상위 %, 기여 변수 최대 4개(이 상권 값·업종 평균·높음/낮음·올림/내림), 10점 구간 분포, 모델 정보(학습 기간·표본·AUC·계수표·등급 구간), 월매출 기본값(원 단위 정수 문자열, 잠정, 근거 원값, 같은 업종 하위·상위 1% 경계 밖인지), 한계 문구를 돌려준다.
- 상위 %는 ⌈순위 ÷ 점수 낸 상권 수 × 100⌉이고, 점수가 같으면 같은 순위다. 업종 평균은 점수 낸 상권의 화면 표시값 산술 평균이다.
- `/markets`는 지표와 점수를 따로 불러온다. 점수를 불러오지 못해도 지표는 그대로 보여 준다.

## 테스트

- 항상: 원본 파싱·헤더 매핑·checksum·거부 규칙, 가짜 서울 API로 API 수신과 적재 원본 구성.
- 항상: 생존점수 변수·라벨·회귀·점수·등급·기여도·예외 상태·월매출 기본값(`score.test.ts`, `build.test.ts`). 계수 파일은 스키마를 통과해야 한다.
- 전용 테스트 DB가 있을 때: 합성 릴리스로 `score:build` 활성화·재실행·실패 시 유지, 점수 API 상태, 계획 스냅샷(`score-db.test.ts`). E2E는 `e2e/market-score.spec.ts`.
- `data/raw/`에 검증본 파일이 있을 때: 기록된 행 수·결합·표본 대조.
- 전용 테스트 DB가 있을 때: 합성 릴리스 적재. 끝나면 지우고 실행 전 ACTIVE 상태를 복원한다.
