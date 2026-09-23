import { z } from 'zod';

export const businessSummaryQuerySchema = z.object({
  districtCode: z.string().regex(/^\d{5}$/),
  detailedIndustryCode: z.string().trim().min(2).max(20),
});
