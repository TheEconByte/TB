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
            // 머리말이 모든 화면에서 세션을 읽는다. 기본 한도(100회)는 요청이 10초 넘게 끊겨야 다시 세므로,
            // 한 주소에서 쉬지 않고 화면을 여는 E2E는 실행 도중 한도를 넘겨 세션 읽기가 429가 된다.
            '/get-session': { window: 10, max: 10_000 },
          },
        }
      : undefined,
});
