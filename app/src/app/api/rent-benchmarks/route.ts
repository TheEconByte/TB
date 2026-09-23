import { apiError } from '@/lib/api';

// Fail closed until an operator-reviewed Korea Real Estate Board snapshot is
// versioned and loaded. Returning sample numbers would turn a reference design
// into an unsupported property-level estimate.
export async function GET() {
  return apiError(503, 'DATASET_UNAVAILABLE', '검수·적재된 한국부동산원 임대료 벤치마크가 아직 없습니다.', {
    source: 'https://www.data.go.kr/data/15069848/fileData.do',
    nullReason: 'OPERATOR_REVIEW_REQUIRED',
  });
}
