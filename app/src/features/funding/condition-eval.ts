import {
  CONDITION_FIELD_NAMES,
  type ConditionFieldName,
  type VerifiedConditions,
  type VerifiedField,
} from './condition-fields.ts';
import { SEOUL_DISTRICTS } from './districts.ts';
import { MATCH_CONDITION_KEYS, matchConditions, type FundingMatchProfile, type MatchConditionKey } from './matching.ts';
import { verifyConditionOutput, type ConditionOutput } from './notice-extraction.ts';

// 공고 조건 추출 평가의 정답과 채점(app/eval/funding-conditions). 운영자 도구이고 웹 요청 경로에서 import하지 않는다.

export type GoldField = {
  mentioned: boolean;
  // 출력 스키마의 value 모양. mentioned인데 null이면 공고가 밝혔지만 형식으로 옮길 수 없는 조건이다.
  value: unknown;
  quote: string;
  confidence: 'clear' | 'ambiguous';
  // 판단이 갈리는 칸에서 정답으로 함께 인정할 값(같은 인용).
  alternatives?: unknown[];
  note?: string;
};

// 프롬프트를 고칠 때 결과를 보는 공고(dev)와, 고친 뒤 비교할 때만 재는 공고(test). test 결과를 보며 프롬프트를 고치면
// test도 고칠 때 본 공고가 되어 새 공고에서 나빠진 것을 잡지 못한다(사용자 결정 2026-11-12).
export const EVAL_SETS = ['dev', 'test'] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

export type GoldCase = {
  id: string;
  set: EvalSet;
  productKey: string;
  textChecksum: string;
  productName: string;
  stratum: string;
  fields: Record<ConditionFieldName, GoldField>;
};

// 칸마다 정답으로 인정하는 저장 모양(검증을 거친 값). 정답도 실제 검증(verifyConditionOutput)을 거쳐 같은 모양으로 맞춘다.
export function expectedFields(
  gold: GoldCase,
  text: string,
): { acceptable: Record<ConditionFieldName, VerifiedField<unknown>[]>; problems: string[] } {
  const raw = (value: unknown) =>
    Object.fromEntries(
      CONDITION_FIELD_NAMES.map((name) => {
        const field = gold.fields[name];
        return [
          name,
          { mentioned: field.mentioned, value: field.mentioned ? (value ?? field.value) : null, quote: field.quote },
        ];
      }),
    ) as ConditionOutput;
  const notice = { productName: gold.productName, text };
  const primary = verifyConditionOutput(raw(undefined), notice);
  const problems: string[] = [];
  const acceptable = {} as Record<ConditionFieldName, VerifiedField<unknown>[]>;
  for (const name of CONDITION_FIELD_NAMES) {
    const field = gold.fields[name];
    const stated = field.mentioned && field.value !== null;
    if (stated && primary[name].status !== 'READ') {
      const reason = primary[name].status === 'UNREADABLE' ? primary[name].reason : primary[name].status;
      problems.push(`${gold.id} ${name}: 정답이 검증을 통과하지 못합니다(${reason})`);
    }
    const options: VerifiedField<unknown>[] = [primary[name]];
    for (const alternative of field.alternatives ?? []) {
      // null은 언급 없음으로 봐도 된다는 뜻이다.
      if (alternative === null) {
        options.push({ status: 'NOT_MENTIONED' });
        continue;
      }
      // 채점은 값만 비교한다. 주 정답이 언급 없음이라 인용이 없으면, 값 검사를 거치도록 본문의 첫 구절을 인용으로 쓴다.
      const entry = { mentioned: true, value: alternative, quote: field.quote || text.trim().slice(0, 30) };
      const checked = verifyConditionOutput({ ...raw(undefined), [name]: entry }, notice)[name];
      if (checked.status === 'READ') options.push(checked);
      else problems.push(`${gold.id} ${name}: 대안 정답이 검증을 통과하지 못합니다`);
    }
    acceptable[name] = options;
  }
  return { acceptable, problems };
}

// 채점은 값의 모양이 아니라 맞춰 보기 판정으로 한다(리뷰 지적 2026-11-04): 사용자 입력마다 맞춰 보기
// (matchConditions)가 내는 판정이 정답과 모두 같으면 같은 답이다. 서울 사용자에게 같은 결과인 차이(다른 시·도가 더
// 있음, 40세 미만과 39세 이하, 겹친 값)는 틀림이 아니다.
// CORRECT: 판정과 상태가 정답과 같다. EQUIVALENT: 판정은 같고 상태만 다르다(언급 없음·읽지 못함·확인 필요로 끝나는 읽음).
// CONFIDENT_WRONG: 어떤 입력에서 정답과 다른 맞음·안 맞음을 낸다(사용자를 잘못 보낸다). MISSED: 정답과 다르지만 다른
// 입력에서는 확인 필요만 낸다(안전하다, 리뷰 지적 2026-11-05). DISPLAY_WRONG: 보여 주기만 하는 지원 방식·신청기간이 틀렸다.
export type FieldOutcome = 'CORRECT' | 'EQUIVALENT' | 'CONFIDENT_WRONG' | 'MISSED' | 'DISPLAY_WRONG';

const AS_OF = '2026-11-04';
const BASE: FundingMatchProfile = {
  businessStatus: 'BUSINESS',
  openedYearMonth: '2023-03',
  age: 37,
  districtCode: '11680',
  targetGroups: [],
};
const TARGET_SETS: FundingMatchProfile['targetGroups'][] = [
  null,
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
    (['WOMEN', 'DISABLED', 'RESTART'] as const).filter((_, index) => bits & (1 << index)),
  ),
];

const boundsOf = (fields: VerifiedField<unknown>[]) =>
  fields.flatMap((field) => {
    if (field.status !== 'READ') return [];
    const range = field.value as { min: number | null; max: number | null };
    return [range.min, range.max].filter((bound): bound is number => bound !== null);
  });

// 기준일에서 몇 달 전 개업인지를 YYYY-MM로.
function openedMonthsAgo(months: number): string {
  const [year, month] = AS_OF.split('-').map(Number);
  const index = year * 12 + (month - 1) - months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// 항목마다 판정이 갈릴 수 있는 입력을 만든다(리뷰 지적 2026-11-05). 정해 둔 입력은 7년·39세 같은 흔한 기준선 사이를 못
// 봤다. 그래서 비교하는 값들의 경계(업력 ±2개월, 나이 ±1세)와 서울 25개 자치구, 대상 조합 8가지를 모두 본다.
// 대상 한정의 청년은 나이 항목으로 보므로 나이도 함께 바꾼다.
function profilesFor(
  name: MatchConditionKey,
  fields: VerifiedField<unknown>[],
  context: VerifiedConditions,
): FundingMatchProfile[] {
  const withBase = (changes: Partial<FundingMatchProfile>[]) => changes.map((change) => ({ ...BASE, ...change }));
  // 나이는 0~120세만 입력할 수 있다(match-profile.ts). 그 밖의 나이로 차이를 지어내지 않는다(리뷰 지적 2026-11-05).
  const ages = (extra: number[]) => [
    ...new Set([
      null,
      ...[0, 18, 25, 37, 45, 60, 120, ...extra.flatMap((bound) => [bound - 1, bound, bound + 1])].filter(
        (age) => age >= 0 && age <= 120,
      ),
    ]),
  ];
  switch (name) {
    case 'businessStage':
      return withBase([{ businessStatus: 'PRE_STARTUP', openedYearMonth: null }, {}, { businessStatus: null }]);
    case 'businessAge': {
      const months = [
        1,
        30,
        60,
        130,
        400,
        ...boundsOf(fields).flatMap((years) => [-2, -1, 0, 1, 2].map((d) => Math.round(years * 12) + d)),
      ];
      return withBase([
        { businessStatus: 'PRE_STARTUP', openedYearMonth: null },
        { businessStatus: 'BUSINESS', openedYearMonth: null },
        { businessStatus: null, openedYearMonth: null },
        ...[...new Set(months)].filter((m) => m >= 0).map((m) => ({ openedYearMonth: openedMonthsAgo(m) })),
      ]);
    }
    case 'age':
      return withBase(ages(boundsOf(fields)).map((age) => ({ age })));
    case 'region':
      return withBase(
        [null, ...SEOUL_DISTRICTS.map((district) => district.code)].map((districtCode) => ({ districtCode })),
      );
    case 'foodBusiness':
      return [BASE];
    case 'targetGroups':
      // 청년은 정답의 나이 항목(청년 기준 나이)으로 보므로 그 경계에서도 본다.
      return TARGET_SETS.flatMap((targetGroups) =>
        ages([39, ...boundsOf([context.age])]).map((age) => ({ ...BASE, targetGroups, age })),
      );
  }
}

const reading = (field: VerifiedField<unknown>) =>
  field.status === 'READ' ? { ...field, source: 'AI' as const } : field;

// 한 항목만 바꿔 끼운 판정 목록. 나머지 항목은 정답으로 두어(대상 한정의 청년은 나이 항목으로 본다) 그 항목의 차이만 보이게 한다.
function verdicts(
  name: MatchConditionKey,
  field: VerifiedField<unknown>,
  context: VerifiedConditions,
  profiles: FundingMatchProfile[],
): string[] {
  const readings = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((key) => [key, reading(key === name ? field : context[key])]),
  ) as Parameters<typeof matchConditions>[0];
  return profiles.map(
    (profile) => matchConditions(readings, profile, AS_OF).find((match) => match.key === name)!.verdict,
  );
}

// 정답과 다른 맞음·안 맞음을 내는 입력이 있으면 위험하다. 확인 필요로만 달라지면 안전하다.
const misleads = (actual: string[], gold: string[]) =>
  actual.some((verdict, index) => verdict !== 'CHECK' && verdict !== gold[index]);

// 보여 주기만 하는 항목. 신청기간은 종료일만 쓰고(AI가 읽은 종료일이 지나면 확인 필요), 지원 방식은 종류만 본다.
function displayed(name: 'applicationPeriod' | 'supportTypes', field: VerifiedField<unknown>): string {
  if (field.status !== 'READ') return name === 'supportTypes' ? '[]' : 'null';
  if (name === 'applicationPeriod') return String((field.value as { end: string | null }).end);
  return JSON.stringify([...new Set(field.value as string[])].sort());
}

function gradeField(
  name: ConditionFieldName,
  actual: VerifiedField<unknown>,
  acceptable: VerifiedField<unknown>[],
  context: VerifiedConditions,
): FieldOutcome {
  const sameAs = (options: VerifiedField<unknown>[]) =>
    options.some((option) => option.status === actual.status) ? 'CORRECT' : 'EQUIVALENT';
  if (!(MATCH_CONDITION_KEYS as readonly string[]).includes(name)) {
    const shown = (field: VerifiedField<unknown>) => displayed(name as 'applicationPeriod' | 'supportTypes', field);
    const same = acceptable.filter((option) => shown(option) === shown(actual));
    if (same.length > 0) return sameAs(same);
    return actual.status === 'READ' ? 'DISPLAY_WRONG' : 'MISSED';
  }
  const key = name as MatchConditionKey;
  const profiles = profilesFor(key, [actual, ...acceptable], context);
  const actualVerdicts = verdicts(key, actual, context, profiles);
  const golds = acceptable.map((option) => ({ option, verdicts: verdicts(key, option, context, profiles) }));
  const same = golds.filter((gold) => gold.verdicts.join() === actualVerdicts.join()).map((gold) => gold.option);
  if (same.length > 0) return sameAs(same);
  // 받아들일 정답 중 하나라도 안전한 차이면 안전하다.
  return golds.some((gold) => !misleads(actualVerdicts, gold.verdicts)) ? 'MISSED' : 'CONFIDENT_WRONG';
}

export const EVAL_METRICS = ['field_acc', 'confident_wrong', 'missed', 'exact_acc'] as const;
export type EvalMetric = (typeof EVAL_METRICS)[number];
export type CaseGrade = {
  outcomes: Record<ConditionFieldName, FieldOutcome>;
  scores: Record<EvalMetric, number>;
};

export function gradeCase(
  actual: VerifiedConditions,
  acceptable: Record<ConditionFieldName, VerifiedField<unknown>[]>,
): CaseGrade {
  const context = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((name) => [name, acceptable[name][0]]),
  ) as VerifiedConditions;
  const outcomes = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((name) => [name, gradeField(name, actual[name], acceptable[name], context)]),
  ) as Record<ConditionFieldName, FieldOutcome>;
  const count = (...kinds: FieldOutcome[]) =>
    CONDITION_FIELD_NAMES.filter((name) => kinds.includes(outcomes[name])).length;
  return {
    outcomes,
    scores: {
      field_acc: count('CORRECT', 'EQUIVALENT') / CONDITION_FIELD_NAMES.length,
      exact_acc: count('CORRECT') / CONDITION_FIELD_NAMES.length,
      // 맞춰 보기에 쓰는 여섯 항목 중 비율이다.
      confident_wrong: count('CONFIDENT_WRONG') / MATCH_CONDITION_KEYS.length,
      missed: count('MISSED') / CONDITION_FIELD_NAMES.length,
    },
  };
}

export type GradedRun = { id: string } & CaseGrade;

export type SetSummary = {
  set: EvalSet;
  // 채점한 공고 수와 회차 수.
  cases: number;
  runs: number;
  // 지표마다 공고별 평균의 평균과 95% 구간의 반폭(공고별 평균의 표준오차 × 1.96). 채점한 회차가 없으면 null이다.
  metrics: Record<EvalMetric, { mean: number; half: number }> | null;
  // 항목마다 결과별 회차 수.
  fields: Record<ConditionFieldName, Record<FieldOutcome, number>>;
};

const OUTCOMES: readonly FieldOutcome[] = ['CORRECT', 'EQUIVALENT', 'CONFIDENT_WRONG', 'MISSED', 'DISPLAY_WRONG'];

// 채점한 회차를 정답의 set마다 따로 요약한다. 같은 공고의 회차는 공고 평균으로 묶어, 회차가 많은 공고가 평균을 끌지 않게 한다.
export function summarizeBySet(cases: readonly GoldCase[], runs: readonly GradedRun[]): SetSummary[] {
  const setOf = new Map(cases.map((item) => [item.id, item.set]));
  for (const run of runs) if (!setOf.has(run.id)) throw new Error(`정답에 없는 공고의 결과입니다: ${run.id}`);
  return EVAL_SETS.filter((set) => cases.some((item) => item.set === set)).map((set) => {
    const inSet = runs.filter((run) => setOf.get(run.id) === set);
    const byCase = new Map<string, GradedRun[]>();
    for (const run of inSet) byCase.set(run.id, [...(byCase.get(run.id) ?? []), run]);
    const metric = (name: EvalMetric) => {
      const perCase = [...byCase.values()].map(
        (list) => list.reduce((sum, run) => sum + run.scores[name], 0) / list.length,
      );
      const mean = perCase.reduce((sum, value) => sum + value, 0) / perCase.length;
      const sd = Math.sqrt(
        perCase.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(perCase.length - 1, 1),
      );
      return { mean, half: (1.96 * sd) / Math.sqrt(perCase.length) };
    };
    return {
      set,
      cases: byCase.size,
      runs: inSet.length,
      metrics:
        inSet.length === 0
          ? null
          : (Object.fromEntries(EVAL_METRICS.map((name) => [name, metric(name)])) as SetSummary['metrics']),
      fields: Object.fromEntries(
        CONDITION_FIELD_NAMES.map((name) => [
          name,
          Object.fromEntries(OUTCOMES.map((kind) => [kind, inSet.filter((run) => run.outcomes[name] === kind).length])),
        ]),
      ) as SetSummary['fields'],
    };
  });
}
