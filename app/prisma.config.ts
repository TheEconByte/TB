import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

// The Prisma CLI does not read Next.js-style env files on its own. Load the
// same files the app uses so `npm run db:*` works with a single app/.env.local.
// loadEnvFile never overwrites an already-set variable, so the first match wins.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) loadEnvFile(file);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Client generation and production builds do not open a connection. Runtime
    // requests still fail closed in src/lib/prisma.ts when DATABASE_URL is absent.
    url: process.env.DATABASE_URL ?? 'postgresql://build:build@127.0.0.1:5433/build',
  },
});
