import { Prisma } from '../../generated/prisma/client.ts';
import type { PlanFundingProfile } from './schema.ts';

// 계획에 저장할 자금 조건을 Prisma JSON 입력으로 바꾼다. 값이 없으면 JSON null이
// 아니라 DB NULL(Prisma.DbNull)로 저장해 "조건을 저장하지 않은 계획"과 빈 조건을
// 구분한다. 재무 계산 입력(inputJson)은 이 값의 영향을 받지 않는다.
export function planFundingProfileJson(
  profile: PlanFundingProfile | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return profile === null || profile === undefined ? Prisma.DbNull : (profile as Prisma.InputJsonValue);
}
