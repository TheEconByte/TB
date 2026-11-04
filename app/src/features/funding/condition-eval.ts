import {
  CONDITION_FIELD_NAMES,
  type ConditionFieldName,
  type VerifiedConditions,
  type VerifiedField,
} from './condition-fields.ts';
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

export type GoldCase = {
  id: string;
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
  const primary = verifyConditionOutput(raw(undefined), text);
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
      const checked = verifyConditionOutput({ ...raw(undefined), [name]: entry }, text)[name];
      if (checked.status === 'READ') options.push(checked);
      else problems.push(`${gold.id} ${name}: 대안 정답이 검증을 통과하지 못합니다`);
    }
    acceptable[name] = options;
  }
  return { acceptable, problems };
}

// 채점은 값의 모양이 아니라 맞춰 보기 판정으로 한다(리뷰 지적 2026-11-04): 여러 사용자 입력에서 맞춰 보기
// (matchConditions)가 내는 판정이 정답과 모두 같으면 같은 답이다. 서울 사용자에게 같은 결과인 차이(다른 시·도가 더
// 있음, 40세 미만과 39세 이하, 겹친 값)는 틀림이 아니다.
// CORRECT: 판정과 상태가 정답과 같다. EQUIVALENT: 판정은 같고 상태만 다르다(언급 없음·읽지 못함·확인 필요로 끝나는 읽음).
// CONFIDENT_WRONG: 읽었다면서 판정이 정답과 다르다(사용자를 잘못된 맞음·안 맞음으로 보낼 수 있다). MISSED: 읽지 못해
// 판정이 다르다(확인 필요로 가므로 안전하다). DISPLAY_WRONG: 보여 주기만 하는 지원 방식·신청기간이 틀렸다.
export type FieldOutcome = 'CORRECT' | 'EQUIVALENT' | 'CONFIDENT_WRONG' | 'MISSED' | 'DISPLAY_WRONG';

const AS_OF = '2026-11-04';
const PROFILES: FundingMatchProfile[] = [
  { businessStatus: 'PRE_STARTUP', openedYearMonth: null },
  { businessStatus: 'BUSINESS', openedYearMonth: '2026-08' },
  { businessStatus: 'BUSINESS', openedYearMonth: '2023-03' },
  { businessStatus: 'BUSINESS', openedYearMonth: '2016-01' },
  { businessStatus: null, openedYearMonth: null },
].flatMap((stage) =>
  [25, 37, 45, 60, null].flatMap((age) =>
    ['11680', '11110', null].flatMap((districtCode) =>
      ([[], ['WOMEN'], ['RESTART'], null] as FundingMatchProfile['targetGroups'][]).map((targetGroups) => ({
        ...(stage as Pick<FundingMatchProfile, 'businessStatus' | 'openedYearMonth'>),
        age,
        districtCode,
        targetGroups,
      })),
    ),
  ),
);

const reading = (field: VerifiedField<unknown>) =>
  field.status === 'READ' ? { ...field, source: 'AI' as const } : field;

// 한 항목만 바꿔 끼운 판정 목록. 나머지 항목은 정답으로 두어(대상 한정의 청년은 나이 항목으로 본다) 그 항목의 차이만 보이게 한다.
function verdicts(name: MatchConditionKey, field: VerifiedField<unknown>, context: VerifiedConditions): string {
  const readings = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((key) => [key, reading(key === name ? field : context[key])]),
  ) as Parameters<typeof matchConditions>[0];
  return PROFILES.map(
    (profile) => matchConditions(readings, profile, AS_OF).find((match) => match.key === name)?.verdict,
  ).join();
}

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
  const matching = (MATCH_CONDITION_KEYS as readonly string[]).includes(name);
  const key = (field: VerifiedField<unknown>) =>
    matching
      ? verdicts(name as MatchConditionKey, field, context)
      : displayed(name as 'applicationPeriod' | 'supportTypes', field);
  const actualKey = key(actual);
  const same = acceptable.filter((option) => key(option) === actualKey);
  if (same.length > 0) return same.some((option) => option.status === actual.status) ? 'CORRECT' : 'EQUIVALENT';
  if (actual.status !== 'READ') return 'MISSED';
  return matching ? 'CONFIDENT_WRONG' : 'DISPLAY_WRONG';
}

export function gradeCase(
  actual: VerifiedConditions,
  acceptable: Record<ConditionFieldName, VerifiedField<unknown>[]>,
): {
  outcomes: Record<ConditionFieldName, FieldOutcome>;
  scores: { field_acc: number; exact_acc: number; confident_wrong: number; missed: number };
} {
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
