import { z } from 'zod';
import { SEOUL_DISTRICTS } from '../funding/districts.ts';
import { BUILDING_TYPES } from './types.ts';

const SEOUL_DISTRICT_CODES = new Set(SEOUL_DISTRICTS.map((district) => district.code));

export const rentBenchmarkQuerySchema = z.object({
  buildingType: z.enum(BUILDING_TYPES),
  districtCode: z
    .string()
    .refine((code) => SEOUL_DISTRICT_CODES.has(code), '서울 자치구 코드를 확인해 주세요.')
    .nullable(),
});
