-- 상품 확정 조건을 대출 가정으로 적용한 출처(상품 키·버전·카탈로그 버전)를 계획과
-- 저장 결과에 남긴다. 재무 계산 입력(inputJson)과 분리한 nullable 컬럼이라 기존
-- 계획, 계산 키, 저장된 plan_results 스냅샷을 바꾸지 않는다.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "loanAssumptionJson" JSONB;

-- AlterTable
ALTER TABLE "plan_results" ADD COLUMN "loanAssumptionJson" JSONB;
