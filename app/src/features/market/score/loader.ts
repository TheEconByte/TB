import { readFileSync } from 'node:fs';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.ts';
import { sha256Hex } from '../checksum.ts';
import { findActiveRelease } from '../read.ts';
import { buildScores, type BuiltScoreRow, type ScoreSummary } from './build.ts';
import { SCORE_BUILD_VERSION } from './config.ts';
import { marketScoreModelSchema, type MarketScoreModel } from './model.ts';
import { loadScoreSeries } from './read.ts';

export type ScoreBuildReport = {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE' | 'REACTIVATED';
  releaseKey: string;
  releaseId: string;
  modelVersion: string;
  marketReleaseKey: string;
  baseQuarter: string;
  rowCount: number;
  summary: ScoreSummary;
  warnings: string[];
};

const INSERT_BATCH = 1000;

export function readModelFile(path: string): { model: MarketScoreModel; checksum: string } {
  const raw = readFileSync(path);
  return { model: marketScoreModelSchema.parse(JSON.parse(raw.toString('utf8'))), checksum: sha256Hex(raw) };
}

// 같은 저장 형식·계수 파일·상권 릴리스면 어느 PC에서나 같은 키가 된다.
export function scoreReleaseKey(model: MarketScoreModel, checksum: string, marketReleaseKey: string, quarter: string) {
  const fingerprint = sha256Hex(`${SCORE_BUILD_VERSION}|${checksum}|${marketReleaseKey}|${quarter}`).slice(0, 12);
  return `${model.version}-${quarter}-${fingerprint}`;
}

function verifyRows(rows: readonly BuiltScoreRow[], summary: ScoreSummary, areaCount: number) {
  const expected = areaCount * summary.servedIndustryCodes.length;
  if (rows.length !== expected) throw new Error(`점수 행 수가 다릅니다: 예상 ${expected}, 실제 ${rows.length}`);
  for (const industry of summary.industries.filter((item) => item.served)) {
    if (industry.scoredCount === 0) throw new Error(`${industry.industryName}: 점수를 낸 상권이 없습니다.`);
  }
  for (const row of rows) {
    if (row.status === 'SCORED' && (row.score === null || row.grade === null || row.rank === null)) {
      throw new Error(`점수 행 값이 비어 있습니다: ${row.industryCode} ${row.areaType}/${row.areaCode}`);
    }
    if (row.status === 'SCORED' && (row.score! < 0 || row.score! > 100)) {
      throw new Error(`점수가 0~100 밖입니다: ${row.industryCode} ${row.areaType}/${row.areaCode} ${row.score}`);
    }
  }
}

export async function buildScoreRelease(options: {
  prisma: PrismaClient;
  modelPath: string;
  log?: (message: string) => void;
}): Promise<ScoreBuildReport> {
  const log = options.log ?? (() => {});
  const { prisma } = options;
  const { model, checksum } = readModelFile(options.modelPath);
  const warnings: string[] = [];

  const marketRelease = await findActiveRelease(prisma);
  if (!marketRelease) throw new Error('ACTIVE 상권 릴리스가 없습니다. market:load를 먼저 실행하세요.');
  if (marketRelease.releaseKey !== model.marketReleaseKey) {
    warnings.push(
      `계수 파일은 ${model.marketReleaseKey}로 학습했고, 점수는 현재 ACTIVE 릴리스 ${marketRelease.releaseKey}로 계산합니다.`,
    );
  }
  const data = await loadScoreSeries(
    prisma,
    model.industries.map((industry) => industry.industryCode),
  );
  const quarter = data.quarters.at(-1);
  if (!quarter) throw new Error('상권 릴리스에 분기 자료가 없습니다.');
  const areas = await prisma.marketArea.findMany({
    where: { releaseId: marketRelease.id },
    select: { areaType: true, areaCode: true },
    orderBy: [{ areaType: 'asc' }, { areaCode: 'asc' }],
  });
  const { rows, summary } = buildScores({ model, seriesByIndustry: data.seriesByIndustry, areas, quarter });
  verifyRows(rows, summary, areas.length);
  for (const industry of summary.industries.filter((item) => !item.served)) {
    warnings.push(
      `${industry.industryName}: 테스트 AUC ${industry.testAuc.toFixed(3)} < ${summary.minTestAuc}라 점수를 내지 않습니다(미지원 업종).`,
    );
  }

  const releaseKey = scoreReleaseKey(model, checksum, marketRelease.releaseKey, quarter);
  const report = (outcome: ScoreBuildReport['outcome'], releaseId: string): ScoreBuildReport => ({
    outcome,
    releaseKey,
    releaseId,
    modelVersion: model.version,
    marketReleaseKey: marketRelease.releaseKey,
    baseQuarter: quarter,
    rowCount: rows.length,
    summary,
    warnings,
  });

  const existing = await prisma.marketScoreRelease.findUnique({ where: { releaseKey } });
  if (existing?.status === 'ACTIVE') {
    log(`같은 점수 릴리스가 이미 활성 상태입니다: ${releaseKey}`);
    return report('ALREADY_ACTIVE', existing.id);
  }
  if (existing?.status === 'SUPERSEDED') {
    // 키가 같으면 내용도 같다. 행을 다시 쓰지 않고 상태만 되돌린다.
    await activate(prisma, existing.id);
    log(`같은 내용의 이전 점수 릴리스를 다시 활성화했습니다: ${releaseKey}`);
    return report('REACTIVATED', existing.id);
  }
  if (existing) {
    log(`완료되지 않은 같은 점수 릴리스(${existing.status})를 정리하고 다시 만듭니다: ${releaseKey}`);
    await prisma.marketScoreRelease.delete({ where: { id: existing.id } });
  }

  const release = await prisma.marketScoreRelease.create({
    data: {
      releaseKey,
      status: 'PENDING',
      modelVersion: model.version,
      modelChecksum: checksum,
      modelJson: model as unknown as Prisma.InputJsonValue,
      marketReleaseId: marketRelease.id,
      marketReleaseKey: marketRelease.releaseKey,
      baseQuarter: quarter,
      summaryJson: summary as unknown as Prisma.InputJsonValue,
    },
  });
  log(`임시 점수 릴리스 ${releaseKey} 생성. 활성화 전까지 조회되지 않습니다.`);

  try {
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      await prisma.marketScore.createMany({
        data: rows.slice(start, start + INSERT_BATCH).map((row) => ({
          releaseId: release.id,
          industryCode: row.industryCode,
          areaType: row.areaType,
          areaCode: row.areaCode,
          status: row.status,
          storeCount: row.storeCount,
          score: row.score,
          grade: row.grade,
          probability: row.probability,
          rank: row.rank,
          monthlyRevenueDefault: row.monthlyRevenueDefault,
          detailJson: row.detail === null ? undefined : (row.detail as unknown as Prisma.InputJsonValue),
        })),
      });
    }
    const stored = await prisma.marketScore.count({ where: { releaseId: release.id } });
    if (stored !== rows.length) throw new Error(`저장된 점수 행 수가 다릅니다: 예상 ${rows.length}, 실제 ${stored}`);
    await activate(prisma, release.id);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await prisma.marketScore.deleteMany({ where: { releaseId: release.id } });
    await prisma.marketScoreRelease.update({
      where: { id: release.id },
      data: { status: 'FAILED', failedAt: new Date(), failureReason: reason.slice(0, 2000) },
    });
    log('실패한 점수 릴리스를 정리했습니다. 기존 활성 점수 릴리스는 그대로 유지됩니다.');
    throw error;
  }
  log(`점수 릴리스 ${releaseKey}를 활성화했습니다.`);
  return report('ACTIVATED', release.id);
}

async function activate(prisma: PrismaClient, releaseId: string) {
  await prisma.$transaction(async (transaction) => {
    await transaction.marketScoreRelease.updateMany({
      where: { status: 'ACTIVE', id: { not: releaseId } },
      data: { status: 'SUPERSEDED' },
    });
    await transaction.marketScoreRelease.update({
      where: { id: releaseId },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
  });
}
