-- 자금 후보 판정용 조건(사업단계·자치구·업종·용도)을 계획에 함께 저장한다.
-- 재무 계산 입력(inputJson)과 분리한 nullable 컬럼이라 기존 계획, 계산 키,
-- 저장된 plan_results 스냅샷을 바꾸지 않는다.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "fundingProfileJson" JSONB;
