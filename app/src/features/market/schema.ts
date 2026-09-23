import { z } from 'zod';

export const marketAreasQuerySchema = z.object({
  districtCode: z.string().trim().min(1).max(20).optional(),
});
export const marketSummaryQuerySchema = z.object({
  areaCode: z.string().trim().min(1).max(20),
  industryCode: z.string().trim().min(1).max(20),
  areaType: z.string().trim().min(1).max(4).optional(),
});

const salesBreakdownPointSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  salesAmount: z.string().regex(/^\d+$/),
  salesCount: z.string().regex(/^\d+$/),
});

export const salesBreakdownSchema = z.object({
  schemaVersion: z.literal('market-sales-breakdown-v1.0.0'),
  dayOfWeek: z.array(salesBreakdownPointSchema).length(7),
  timeOfDay: z.array(salesBreakdownPointSchema).length(6),
  gender: z.array(salesBreakdownPointSchema).length(2),
  age: z.array(salesBreakdownPointSchema).length(6),
  limitations: z.array(z.string().min(1)),
});
