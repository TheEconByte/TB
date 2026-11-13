import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import {
  EVAL_METRICS,
  GROUP_PROFILE_NAMES,
  EVAL_SETS,
  expectedFields,
  gradeCase,
  summarizeBySet,
  type GoldCase,
} from '../src/features/funding/condition-eval.ts';
import { CONDITION_FIELD_NAMES } from '../src/features/funding/condition-fields.ts';
import {
  CONDITION_MODEL,
  CONDITION_PROMPT_VERSION,
  ConditionExtractionFailure,
  createClaudeConditionExtractor,
  verifyConditionOutput,
  type ConditionOutput,
  type NoticeSource,
} from '../src/features/funding/notice-extraction.ts';
import { secretMasker } from '../src/features/market/seoul-api.ts';

// 공고 조건 추출 평가(app/eval/funding-conditions). funding:sync와 같은 추출 코드를 정답 공고에 돌려 채점한다.
// 실제 Claude API를 부르므로 운영자만 실행한다. 본문은 저장소에 두지 않고 앱 DB의 funding_notice_texts에서 읽는다.

const HELP = `사용법: npm --prefix app run eval:funding-conditions -- [--variant <이름>] [--reps <n>] [--set <dev|test|all>]

  --variant <이름>  결과를 쓸 폴더 이름. baseline 또는 v1, v2 ... (기본값: baseline)
  --reps <n>        공고마다 몇 번 읽을지(기본값: 2). 같은 공고도 매번 결과가 조금씩 달라서 두 번 이상 본다.
  --set <이름>      읽을 정답 공고. dev는 프롬프트를 고칠 때 보는 공고, test는 고친 뒤 비교할 때만 재는 공고다.
                    고치는 동안에는 dev만 돌린다. (기본값: all)

결과: .claude/hillclimb/funding-conditions/<variant>/results.jsonl, traces/, errors.jsonl
이미 쓴 (공고, 회차)는 건너뛴다. 끊긴 뒤 다시 실행하면 이어서 한다.

환경 변수(app/.env.local): DATABASE_URL, ANTHROPIC_API_KEY`;

const CASES = fileURLToPath(new URL('../eval/funding-conditions/cases.json', import.meta.url));
const FLOW_DIR = fileURLToPath(new URL('../../.claude/hillclimb/funding-conditions/', import.meta.url));
const CONCURRENCY = 4;

type Row = {
  prompt_id: string;
  rep: number;
  grade: Record<string, number>;
  meta: { prompt: string; outcomes: Record<string, string> };
};
type Expected = Map<string, ReturnType<typeof expectedFields>>;

// 요청 전체(모델·시스템 프롬프트·메시지 틀·출력 스키마·그 밖의 매개변수)의 지문. 실제 추출 코드가 만드는 요청을
// 보내지 않고 받아 적어 만든다. 본문·상품 이름은 고정 값이라 지문이 흔들리지 않는다. 같은 variant에 다른 지문의 결과가
// 섞이지 않게 한다(리뷰 지적 2026-11-04·05).
async function promptFingerprint(): Promise<string> {
  let body = '';
  const client = new Anthropic({
    apiKey: 'fingerprint-only',
    maxRetries: 0,
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      throw new Error('보내지 않는다');
    },
  });
  await createClaudeConditionExtractor(client)('본문', '상품').catch(() => undefined);
  if (body === '') throw new Error('추출 코드가 요청을 만들지 않았습니다.');
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

// 끝이 잘린 줄(실행이 끊긴 경우)은 건너뛰고 알린다.
function readRows(file: string): Row[] {
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      console.log(`읽을 수 없는 결과 줄을 건너뜁니다: ${line.slice(0, 60)}`);
    }
  }
  return rows;
}

async function main() {
  const { values } = parseArgs({
    options: {
      variant: { type: 'string', default: 'baseline' },
      reps: { type: 'string', default: '2' },
      set: { type: 'string', default: 'all' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const variant = values.variant;
  const reps = Number(values.reps);
  const sets = values.set === 'all' ? EVAL_SETS : EVAL_SETS.filter((set) => set === values.set);
  if (!/^(baseline|v\d+)$/.test(variant) || !Number.isInteger(reps) || reps < 1 || sets.length === 0)
    throw new Error(HELP);
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  if (!databaseUrl || apiKey === '') throw new Error('DATABASE_URL과 ANTHROPIC_API_KEY가 필요합니다(app/.env.local).');
  const mask = secretMasker(apiKey);

  const allCases = JSON.parse(readFileSync(CASES, 'utf8')) as GoldCase[];
  const cases = allCases.filter((item) => (sets as readonly string[]).includes(item.set));
  const otherSets = new Set(allCases.filter((item) => !cases.includes(item)).map((item) => item.id));
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  // AI에 보내는 공고(상품 이름과 본문). 인용 검증도 같은 두 글로 한다.
  const notices = new Map<string, NoticeSource>();
  try {
    for (const item of cases) {
      const row = await prisma.fundingNoticeText.findFirst({
        where: { productKey: item.productKey, textChecksum: item.textChecksum },
        select: { text: true },
      });
      if (row) notices.set(item.id, { productName: item.productName, text: row.text });
    }
  } finally {
    await prisma.$disconnect();
  }
  const missing = cases.filter((item) => !notices.has(item.id)).map((item) => item.id);
  if (missing.length > 0)
    throw new Error(`DB에 본문이 없습니다: ${missing.join(', ')}. funding:sync를 먼저 실행하세요.`);

  // 정답도 실제 검증을 통과해야 한다. 통과하지 못하면 정답이 틀렸으므로 채점하지 않는다.
  const expected = new Map(cases.map((item) => [item.id, expectedFields(item, notices.get(item.id)!.text)]));
  const problems = [...expected.values()].flatMap((entry) => entry.problems);
  if (problems.length > 0) throw new Error(`정답 문제:\n${problems.join('\n')}`);

  const dir = join(FLOW_DIR, variant);
  mkdirSync(join(dir, 'traces'), { recursive: true });
  const resultsFile = join(dir, 'results.jsonl');
  writeStateOnce();
  const fingerprint = await promptFingerprint();
  const existing = readRows(resultsFile);
  const others = [
    ...new Set(existing.map((row) => row.meta?.prompt ?? '(지문 없음)').filter((prompt) => prompt !== fingerprint)),
  ];
  if (others.length > 0) {
    throw new Error(
      `${variant}에는 다른 프롬프트(${others.join(', ')})의 결과가 있습니다. 지금 프롬프트(${fingerprint})는 새 variant 이름으로 실행하세요.`,
    );
  }
  // trace가 없는 결과는 채점할 수 없으므로 다시 실행한다(요약은 같은 회차의 첫 채점 가능한 결과만 쓴다).
  const done = new Set(
    existing
      .filter((row) => existsSync(join(dir, 'traces', `${row.prompt_id}_rep${row.rep}.json`)))
      .map((row) => `${row.prompt_id}#${row.rep}`),
  );
  const jobs = cases.flatMap((item) =>
    Array.from({ length: reps }, (_, rep) => ({ item, rep })).filter(({ rep }) => !done.has(`${item.id}#${rep}`)),
  );
  console.log(
    `${variant}: ${CONDITION_MODEL} · ${CONDITION_PROMPT_VERSION} · 프롬프트 ${fingerprint} · ${sets.join('·')} 공고 ${cases.length}건 · ${jobs.length}회 실행(이미 ${cases.length * reps - jobs.length}회)`,
  );

  const runJob = async ({ item, rep }: (typeof jobs)[number]) => {
    const notice = notices.get(item.id)!;
    // 실제 추출 코드를 그대로 부르고, 요청과 응답은 fetch에서 옮겨 적는다(모델·stop_reason·사용량 기록).
    const seen: { request?: Record<string, unknown>; response?: Record<string, unknown> } = {};
    // 시간 제한·재시도는 funding:sync처럼 SDK 기본값을 쓴다.
    const client = new Anthropic({
      apiKey,
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.request = JSON.parse(String(init?.body));
        const response = await fetch(url, init);
        if (response.ok) seen.response = (await response.clone().json()) as Record<string, unknown>;
        return response;
      },
    });
    const started = Date.now();
    try {
      const result = await createClaudeConditionExtractor(client)(notice.text, notice.productName);
      const model = String(seen.response?.model ?? '');
      if (!model.startsWith(CONDITION_MODEL)) throw new Error(`요청한 모델과 다른 모델이 답했습니다: ${model}`);
      const verified = verifyConditionOutput(result.output, notice);
      const target = expected.get(item.id)!;
      const { outcomes, groups, scores } = gradeCase(verified, target.acceptable, target.titleRegionMark);
      writeFileSync(
        join(dir, 'traces', `${item.id}_rep${rep}.json`),
        JSON.stringify(
          [
            { role: 'system', content: String(seen.request?.system ?? '') },
            { role: 'user', content: (seen.request?.messages as Array<{ content: string }>)[0].content },
            { role: 'assistant', content: JSON.stringify(result.output, null, 2) },
            { role: 'tool_result', name: 'grade', content: JSON.stringify({ verified, outcomes, groups }, null, 2) },
          ],
          null,
          1,
        ),
      );
      appendLine(
        resultsFile,
        JSON.stringify({
          prompt_id: item.id,
          rep,
          prompt: item.productName,
          tags: [item.stratum],
          status: 'ok',
          stop_reason: seen.response?.stop_reason,
          model,
          usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
          latency_s: (Date.now() - started) / 1000,
          grade: scores,
          meta: { prompt: fingerprint, promptVersion: CONDITION_PROMPT_VERSION, outcomes },
        }),
      );
    } catch (error) {
      // 점수를 낼 수 없는 실패는 결과에 넣지 않는다(다음 실행에서 다시 한다). 끝까지 오지 않은 응답도 여기다.
      const failure = error instanceof ConditionExtractionFailure ? error : null;
      appendLine(
        join(dir, 'errors.jsonl'),
        JSON.stringify({
          prompt_id: item.id,
          rep,
          error: mask(error instanceof Error ? error.message : String(error)),
          model: seen.response?.model,
          usage: failure ? { input_tokens: failure.inputTokens, output_tokens: failure.outputTokens } : undefined,
        }),
      );
      console.log(`  실패 ${item.id}#${rep}: ${mask(error instanceof Error ? error.message : String(error))}`);
    }
  };
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
    }),
  );
  summarize(dir, cases, otherSets, expected, notices, reps);
}

// 한 줄을 붙여 쓴다. 끊긴 실행이 남긴 잘린 줄이 있으면 먼저 끝내서 새 줄이 그 뒤에 붙지 않게 한다.
function appendLine(file: string, line: string) {
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${content.length > 0 && !content.endsWith('\n') ? '\n' : ''}${line}\n`);
}

function writeStateOnce() {
  const file = join(FLOW_DIR, '_state.json');
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        metrics: [
          { id: 'field_acc', label: '항목 정확도', kind: 'float', scale: 1 },
          { id: 'confident_wrong', label: '위험한 오답', kind: 'float', scale: 1, better: 'lower' },
          { id: 'missed', label: '놓침', kind: 'float', scale: 1, better: 'lower' },
          { id: 'exact_acc', label: '완전 일치', kind: 'float', scale: 1 },
          { id: 'group_changed', label: '그룹 달라짐', kind: 'float', scale: 1, better: 'lower' },
          { id: 'group_surfaced', label: '그룹 잘못 올라옴', kind: 'float', scale: 1, better: 'lower' },
        ],
        perf_fields: [{ id: 'in_tokens' }, { id: 'out_tokens' }, { id: 'latency_s', unit: 's' }],
      },
      null,
      2,
    ),
  );
}

// set마다 지표의 평균과 95% 구간(공고별 평균의 표준오차 × 1.96), 항목별 결과 수를 보여 준다. 정답이나 검증 규칙을
// 고쳐도 다시 부르지 않도록, 저장한 AI 원답(traces)을 지금 공고(제목·본문)로 다시 검증하고 지금 정답으로 다시 채점한다.
// results.jsonl의 grade는 실행 당시의 점수이고, 이 요약이 기준이다. 고르지 않은 set의 결과는 요약에 넣지 않는다.
function summarize(
  dir: string,
  cases: readonly GoldCase[],
  otherSets: ReadonlySet<string>,
  expected: Expected,
  notices: Map<string, NoticeSource>,
  reps: number,
) {
  const planned = new Set(cases.flatMap((item) => Array.from({ length: reps }, (_, rep) => `${item.id}#${rep}`)));
  const skipped: string[] = [];
  const seen = new Set<string>();
  const graded = readRows(join(dir, 'results.jsonl')).flatMap((row) => {
    const key = `${row.prompt_id}#${row.rep}`;
    if (otherSets.has(row.prompt_id)) return [];
    if (!planned.has(key)) {
      skipped.push(`${key}(지금 공고·회차에 없음)`);
      return [];
    }
    const traceFile = join(dir, 'traces', `${row.prompt_id}_rep${row.rep}.json`);
    if (!existsSync(traceFile)) {
      skipped.push(`${key}(trace 없음, 다음 실행에서 다시 함)`);
      return [];
    }
    // 같은 회차가 두 번 쓰였으면(두 실행이 겹친 경우) 처음 것만 쓴다.
    if (seen.has(key)) {
      skipped.push(`${key}(중복)`);
      return [];
    }
    seen.add(key);
    const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as Array<{ role: string; content: string }>;
    const output = JSON.parse(trace.find((turn) => turn.role === 'assistant')!.content) as ConditionOutput;
    const verified = verifyConditionOutput(output, notices.get(row.prompt_id)!);
    const target = expected.get(row.prompt_id)!;
    return [{ id: row.prompt_id, ...gradeCase(verified, target.acceptable, target.titleRegionMark) }];
  });
  const lines: string[] = [];
  if (skipped.length > 0) lines.push(`채점하지 않은 결과: ${skipped.join(', ')}`);
  for (const summary of summarizeBySet(cases, graded)) {
    const plannedRuns = cases.filter((item) => item.set === summary.set).length * reps;
    lines.push(`[${summary.set}] 공고 ${summary.cases}건 · 채점한 실행 ${summary.runs}/${plannedRuns}회`);
    // 실패한 회차는 평균에서 빠진다. 실패가 많은 프롬프트가 쉬운 공고로만 평균을 내지 않도록 빠진 수를 함께 보인다.
    if (summary.runs < plannedRuns) {
      lines.push(
        `  주의: ${plannedRuns - summary.runs}회는 점수가 없습니다(errors.jsonl). 다시 실행하면 이어서 합니다.`,
      );
    }
    if (summary.metrics === null) continue;
    for (const metric of EVAL_METRICS) {
      const { mean, half } = summary.metrics[metric];
      lines.push(`  ${metric}: ${(mean * 100).toFixed(1)}% (±${(half * 100).toFixed(1)}%p)`);
    }
    lines.push('  항목별 (맞음/같은 확인 필요/위험한 오답/놓침/보여 주기 틀림):');
    for (const name of CONDITION_FIELD_NAMES) {
      const count = summary.fields[name];
      lines.push(
        `    ${name}: ${count.CORRECT}/${count.EQUIVALENT}/${count.CONFIDENT_WRONG}/${count.MISSED}/${count.DISPLAY_WRONG}`,
      );
    }
    lines.push('  화면 그룹, 입력별 (정답과 같음/앞의 두 그룹에 잘못 올라옴/그 밖의 차이):');
    for (const name of GROUP_PROFILE_NAMES) {
      const count = summary.groups[name];
      lines.push(`    ${name}: ${count.SAME}/${count.SURFACED}/${count.OTHER}`);
    }
  }
  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
