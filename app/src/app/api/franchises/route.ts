import { apiError } from '@/lib/api';

// Brand comparisons require a reviewed disclosure snapshot with a common area
// basis and explicit exclusions. No placeholder brands or zero-valued costs are
// served before that catalog exists.
export async function GET() {
  return apiError(503, 'DATASET_UNAVAILABLE', '검수·적재된 공정위 프랜차이즈 공시 카탈로그가 아직 없습니다.', {
    source: 'https://franchise.ftc.go.kr/firHope/comparePopup.do',
    nullReason: 'OPERATOR_REVIEW_REQUIRED',
  });
}
