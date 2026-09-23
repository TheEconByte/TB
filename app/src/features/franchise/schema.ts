import { z } from 'zod';

export const franchiseQuerySchema = z.object({
  industryCode: z.enum(['CS100001', 'CS100010']),
  query: z.string().trim().max(40, '검색어는 40자 이하로 입력해 주세요.'),
  limit: z.coerce.number().int().min(1).max(50),
});
