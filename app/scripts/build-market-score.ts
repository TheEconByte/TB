import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { buildScoreRelease } from '../src/features/market/score/loader.ts';

const USAGE = `사용법: npm --prefix app run score:build [-- --model <계수 파일>]

계수 파일과 ACTIVE 상권 릴리스로 최신 기준분기의 상권 생존점수를 계산해 새 점수 릴리스로
저장하고, 검증을 통과하면 활성화한다(ADR 0008). 실패하면 기존 활성 점수 릴리스를 유지한다.
테스트 AUC가 기준 미만인 업종은 점수를 내지 않는다.

  --model <경로>   기본값: app/models/market-score에서 이름순 마지막 .json
  DATABASE_URL     PostgreSQL 연결 문자열`;

const MODEL_DIR = resolve(import.meta.dirname, '..', 'models', 'market-score');

function parseArgs(argv: string[]): { model: string | null; help: boolean } {
  const options = { model: null as string | null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else if (argv[i] === '--model') options.model = argv[++i] ?? null;
    else throw new Error(`알 수 없는 옵션: ${argv[i]}`);
  }
  return options;
}

function latestModelPath(): string {
  const files = readdirSync(MODEL_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`${MODEL_DIR}에 계수 파일이 없습니다. score:train을 먼저 실행하세요.`);
  return resolve(MODEL_DIR, files.at(-1)!);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL이 없습니다. app/.env.local을 준비하거나 DATABASE_URL을 지정해 주세요.');
  const modelPath = options.model ? resolve(options.model) : latestModelPath();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    console.log(`계수 파일: ${modelPath}`);
    const report = await buildScoreRelease({ prisma, modelPath, log: (message) => console.log(message) });
    for (const warning of report.warnings) console.warn(`경고: ${warning}`);
    console.log('');
    console.log(`결과: ${report.outcome}`);
    console.log(`점수 릴리스: ${report.releaseKey}`);
    console.log(
      `모델 ${report.modelVersion} · 상권 릴리스 ${report.marketReleaseKey} · 기준분기 ${report.baseQuarter}`,
    );
    for (const industry of report.summary.industries) {
      console.log(
        industry.served
          ? `  ${industry.industryName}: 점수 낸 상권 ${industry.scoredCount}곳 · 등급 ${Object.entries(
              industry.gradeCounts,
            )
              .map(([grade, count]) => `${grade} ${count}`)
              .join(', ')}`
          : `  ${industry.industryName}: 미지원(테스트 AUC ${industry.testAuc.toFixed(3)})`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
