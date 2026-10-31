import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { format, resolveConfig } from 'prettier';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { quartersBetween } from '../src/features/market/quarter.ts';
import {
  ACTIVE_FEATURE_KEYS,
  COMPARISON_MODELS,
  DEFAULT_GRADE_BOUNDARIES,
  MIN_STORE_COUNT,
  MODEL_DEFINITION_VERSION,
  SCORE_INDUSTRY_CODES,
} from '../src/features/market/score/config.ts';
import { loadScoreSeries } from '../src/features/market/score/read.ts';
import { marketScoreModelSchema, type MarketScoreModel } from '../src/features/market/score/model.ts';
import { renderTrainingReport, type LatestQuarterSummary } from '../src/features/market/score/report.ts';
import { scoreQuarter, trainIndustryModel } from '../src/features/market/score/train.ts';
import { supportedIndustry } from '../src/features/market/types.ts';

const USAGE = `사용법: npm --prefix app run score:train [-- --version <버전>]

ACTIVE 상권 릴리스로 업종별 상권 생존점수 모델을 학습하고(ADR 0008)
app/models/market-score/<버전>.json(계수)과 <버전>.report.md(학습 리포트)를 만든다.
같은 학습·테스트 행으로 기준선(직전 1년 폐업률)과 결합 모델도 학습해 리포트에서 비교한다.
같은 버전 파일이 있으면 덮어쓰지 않는다.

  --version <버전>   기본값: market-score-<모델 정의 버전>-<데이터 끝 분기>
  DATABASE_URL       PostgreSQL 연결 문자열`;

const MODEL_DIR = resolve(import.meta.dirname, '..', 'models', 'market-score');

function parseArgs(argv: string[]): { version: string | null; help: boolean } {
  const options = { version: null as string | null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else if (argv[i] === '--version') options.version = argv[++i] ?? null;
    else throw new Error(`알 수 없는 옵션: ${argv[i]}`);
  }
  return options;
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
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const data = await loadScoreSeries(prisma, SCORE_INDUSTRY_CODES);
    const expected = quartersBetween(data.quarters[0], data.quarters.at(-1)!);
    if (expected.join() !== data.quarters.join())
      throw new Error(`분기가 연속되지 않습니다: ${data.quarters.join(',')}`);
    const dataStart = data.quarters[0];
    const dataEnd = data.quarters.at(-1)!;
    const version =
      options.version ?? `market-score-${MODEL_DEFINITION_VERSION.replace('market-score-def-', '')}-${dataEnd}`;
    const jsonPath = resolve(MODEL_DIR, `${version}.json`);
    const reportPath = resolve(MODEL_DIR, `${version}.report.md`);
    if (existsSync(jsonPath) || existsSync(reportPath)) {
      throw new Error(
        `${version} 파일이 이미 있습니다. 계수 파일은 덮어쓰지 않습니다. --version으로 새 버전을 지정하세요.`,
      );
    }
    console.log(`상권 릴리스 ${data.releaseKey}, 분기 ${dataStart}~${dataEnd} (${data.quarters.length}개)`);

    const results = SCORE_INDUSTRY_CODES.map((industryCode) => {
      const industryName = supportedIndustry(industryCode)?.displayName ?? industryCode;
      const result = trainIndustryModel({
        industryCode,
        industryName,
        seriesList: data.seriesByIndustry.get(industryCode) ?? [],
        dataStart,
        dataEnd,
        featureKeys: ACTIVE_FEATURE_KEYS,
        comparisonModels: COMPARISON_MODELS,
        minStoreCount: MIN_STORE_COUNT,
        gradeBoundaries: [...DEFAULT_GRADE_BOUNDARIES],
      });
      console.log(`${industryName}: 학습 ${result.model.trainSize} · 테스트 ${result.model.testSize}`);
      for (const item of result.comparisons) {
        console.log(
          `  ${item.label}: 테스트 AUC ${item.evaluation.testAuc.toFixed(3)} · KS ${item.evaluation.ks.toFixed(3)}`,
        );
      }
      return result;
    });

    const model: MarketScoreModel = marketScoreModelSchema.parse({
      version,
      definitionVersion: MODEL_DEFINITION_VERSION,
      createdAt: new Date().toISOString(),
      marketReleaseKey: data.releaseKey,
      dataPeriod: { start: dataStart, end: dataEnd },
      minStoreCount: MIN_STORE_COUNT,
      gradeBoundaries: [...DEFAULT_GRADE_BOUNDARIES],
      industries: results.map((result) => result.model),
    });

    const latest: Record<string, LatestQuarterSummary> = {};
    for (const industry of model.industries) {
      latest[industry.industryCode] = {
        quarter: dataEnd,
        ...scoreQuarter({
          model: industry,
          seriesList: data.seriesByIndustry.get(industry.industryCode) ?? [],
          quarter: dataEnd,
          minStoreCount: model.minStoreCount,
          gradeBoundaries: model.gradeBoundaries,
        }),
      };
    }

    mkdirSync(MODEL_DIR, { recursive: true });
    // format:check와 같은 결과가 되도록 저장소의 Prettier 설정으로 포맷한다.
    const prettierOptions = { ...(await resolveConfig(jsonPath)), filepath: jsonPath };
    writeFileSync(jsonPath, await format(JSON.stringify(model), prettierOptions), { flag: 'wx' });
    writeFileSync(reportPath, renderTrainingReport({ model, results, latest }), { flag: 'wx' });
    console.log(`계수: ${jsonPath}`);
    console.log(`리포트: ${reportPath}`);
    const failing = model.industries.filter((industry) => industry.testAuc < 0.6);
    if (failing.length > 0) {
      console.log(
        `테스트 AUC 0.6 미달: ${failing.map((item) => item.industryName).join(', ')}. 미달 업종은 점수를 내지 않습니다(미지원 업종).`,
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
