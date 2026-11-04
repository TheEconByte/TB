import {
  CONDITION_FIELD_NAMES,
  type ConditionFieldName,
  type VerifiedConditions,
  type VerifiedField,
} from './condition-fields.ts';
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

// CORRECT: 상태와 값이 정답과 같다. EQUIVALENT: 언급 없음·읽지 못함처럼 맞춰 보기에서 같은 확인 필요가 된다.
// CONFIDENT_WRONG: 읽었다면서 값이 틀리다(사용자를 잘못된 맞음·안 맞음으로 보낼 수 있다). MISSED: 정답은 읽음인데
// 읽지 못했다(확인 필요로 가므로 안전하다).
export type FieldOutcome = 'CORRECT' | 'EQUIVALENT' | 'CONFIDENT_WRONG' | 'MISSED';

const sorted = (values: unknown) => [...((values as string[] | undefined) ?? [])].sort();
const sameList = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// 맞춰 보기에 쓰는 부분만 비교한다. 목록 순서, 신청기간의 원문 표기, 대상 메모는 보지 않는다.
function sameValue(name: ConditionFieldName, a: unknown, b: unknown): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  switch (name) {
    case 'businessStage':
    case 'foodBusiness':
      return a === b;
    case 'businessAge':
    case 'age':
      return x.min === y.min && x.max === y.max && (x.max === null || x.maxExclusive === y.maxExclusive);
    case 'region':
      return (
        x.scope === y.scope &&
        sameList(x.provinces, y.provinces) &&
        sameList(x.districtCodes, y.districtCodes) &&
        sameList(x.excludedProvinces, y.excludedProvinces) &&
        sameList(x.excludedDistrictCodes, y.excludedDistrictCodes)
      );
    case 'targetGroups':
      return sameList(x.groups, y.groups);
    case 'applicationPeriod':
      return x.start === y.start && x.end === y.end;
    case 'supportTypes':
      return sameList(a, b);
  }
}

function gradeField(
  name: ConditionFieldName,
  actual: VerifiedField<unknown>,
  acceptable: VerifiedField<unknown>[],
): FieldOutcome {
  if (actual.status === 'READ') {
    const matches = acceptable.some(
      (option) => option.status === 'READ' && sameValue(name, actual.value, option.value),
    );
    return matches ? 'CORRECT' : 'CONFIDENT_WRONG';
  }
  const unread = acceptable.filter((option) => option.status !== 'READ');
  if (unread.length === 0) return 'MISSED';
  return unread.some((option) => option.status === actual.status) ? 'CORRECT' : 'EQUIVALENT';
}

export function gradeCase(
  actual: VerifiedConditions,
  acceptable: Record<ConditionFieldName, VerifiedField<unknown>[]>,
): {
  outcomes: Record<ConditionFieldName, FieldOutcome>;
  scores: { field_acc: number; exact_acc: number; confident_wrong: number; missed: number };
} {
  const outcomes = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((name) => [name, gradeField(name, actual[name], acceptable[name])]),
  ) as Record<ConditionFieldName, FieldOutcome>;
  const share = (...kinds: FieldOutcome[]) =>
    CONDITION_FIELD_NAMES.filter((name) => kinds.includes(outcomes[name])).length / CONDITION_FIELD_NAMES.length;
  return {
    outcomes,
    scores: {
      field_acc: share('CORRECT', 'EQUIVALENT'),
      exact_acc: share('CORRECT'),
      confident_wrong: share('CONFIDENT_WRONG'),
      missed: share('MISSED'),
    },
  };
}
