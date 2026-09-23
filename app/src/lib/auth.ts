import { prismaAdapter } from '@better-auth/prisma-adapter';
import { betterAuth } from 'better-auth/minimal';
import { getPrisma } from './prisma';

export const auth = betterAuth({
  appName: 'TrendBench',
  database: prismaAdapter(getPrisma(), { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  advanced: {
    database: {
      joins: true,
    },
  },
  rateLimit:
    process.env.TRENDBENCH_E2E === '1'
      ? {
          customRules: {
            '/sign-in/email': { window: 10, max: 100 },
            '/sign-up/email': { window: 10, max: 100 },
          },
        }
      : undefined,
});
