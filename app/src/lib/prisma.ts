import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  // A non-routable fallback lets `next build` inspect route modules without a
  // secret. Any runtime DB operation still fails instead of using local data.
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured';
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export function getPrisma() {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createPrismaClient();
  return globalForPrisma.prisma;
}
