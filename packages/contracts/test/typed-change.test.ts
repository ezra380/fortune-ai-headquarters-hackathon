import { describe, expect, it } from 'vitest';
import { ChangeKind, MANAGER_APPLIES, ManagerReview, RecommendationDetail, TypedManagerReview, TypedRecommendation } from '../src/index.ts';

// What a recommendation changes, and who applies it. The table decides who, never the model.

const base = { rank: 1, assistant: 'finance', change: 'Ask which month before answering.', why: 'Two answers used the wrong month.' };
const parse = (over: Record<string, unknown>) => TypedRecommendation.safeParse({ ...base, ...over });
const firstIssue = (over: Record<string, unknown>) => {
  const r = parse(over);
  return r.success ? null : `${r.error.issues[0]!.path.join('.')}: ${r.error.issues[0]!.message}`;
};

describe('TypedRecommendation', () => {
  it('reads a recommendation from before kinds as a lesson', () => {
    expect(parse({}).data).toEqual({ ...base, kind: 'lesson' });
  });

  it('takes each kind with the detail that kind needs', () => {
    expect(parse({ kind: 'skill_note' }).success).toBe(true);
    expect(parse({ kind: 'reads', reads: { add: ['my_lessons'] } }).data).toMatchObject({ kind: 'reads', reads: { add: ['my_lessons'], remove: [] } });
    expect(parse({ kind: 'reads', reads: { remove: ['open_items'] } }).data).toMatchObject({ reads: { add: [], remove: ['open_items'] } });
    expect(parse({ kind: 'model', model: { job: 'answer', model: 'nvidia/nemotron-3-ultra-550b-a55b' } }).success).toBe(true);
  });

  it('refuses a reads change with nothing in it, or with a tool both added and removed', () => {
    expect(firstIssue({ kind: 'reads' })).toBe('reads: a reads change needs the tool names to add or remove');
    expect(firstIssue({ kind: 'reads', reads: { add: [], remove: [] } })).toBe('reads: a reads change needs the tool names to add or remove');
    expect(firstIssue({ kind: 'reads', reads: { add: ['my_lessons'], remove: ['my_lessons'] } })).toBe('reads: a tool cannot be both added and removed');
  });

  it('refuses a tool name that is not shaped like one, and more than five at a time', () => {
    for (const bad of ['Get_Metrics', 'get-metrics', 'x', 'a'.repeat(61), "get_x'; drop table", 'get_x get_y']) {
      expect(parse({ kind: 'reads', reads: { add: [bad] } }).success, bad).toBe(false);
    }
    expect(parse({ kind: 'reads', reads: { add: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] } }).success).toBe(false);
  });

  it('keeps detail that belongs to another kind out', () => {
    expect(firstIssue({ reads: { add: ['my_lessons'] } })).toBe('reads: a lesson recommendation takes no reads');
    expect(firstIssue({ kind: 'skill_note', model: { job: 'code', model: 'm1' } })).toBe('model: a skill_note recommendation takes no model');
    expect(firstIssue({ kind: 'model' })).toBe('model: a model change needs the job and the model');
    expect(firstIssue({ kind: 'model', reads: { add: ['my_lessons'] }, model: { job: 'code', model: 'm1' } })).toBe('reads: a model recommendation takes no reads');
  });

  it('lets the manager change only the jobs the worker runs for an assistant, and only with a plain model name', () => {
    for (const job of ['plan', 'route', 'anything']) {
      expect(parse({ kind: 'model', model: { job, model: 'm1' } }).success, job).toBe(false);
    }
    for (const model of ['', ' x', 'x y', 'x;y', '../x', '$(x)', 'm'.repeat(121)]) {
      expect(parse({ kind: 'model', model: { job: 'code', model } }).success, model).toBe(false);
    }
    expect(parse({ kind: 'model', model: { job: 'review', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' } }).success).toBe(true);
  });

  it('refuses an unknown kind and an unknown field', () => {
    expect(parse({ kind: 'delete_profile' }).success).toBe(false);
    expect(parse({ kind: 'reads', reads: { add: ['my_lessons'], extra: 1 } }).success).toBe(false);
  });

  it('takes a retire with its target, the exact text and why, and nothing else', () => {
    const retire = { target: 'lesson', text: 'Name the month in every answer.', why: 'A newer lesson says the same.' };
    expect(parse({ kind: 'retire', retire }).data).toMatchObject({ kind: 'retire', retire });
    expect(parse({ kind: 'retire', retire: { ...retire, target: 'note' } }).success).toBe(true);
    expect(firstIssue({ kind: 'retire' })).toBe('retire: a retire needs the target, the exact text and why');
    expect(firstIssue({ retire })).toBe('retire: a lesson recommendation takes no retire');
    for (const bad of [{ ...retire, target: 'skill' }, { ...retire, text: '' }, { ...retire, why: '' }, { ...retire, text: 'x'.repeat(301) }, { ...retire, extra: 1 }, { target: 'lesson', text: 'x' }]) {
      expect(parse({ kind: 'retire', retire: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the review the manager writes', () => {
  const review = (recs: unknown[]) => ({ summary: 'Finance did 5 tasks.', findings: [], recommendations: recs });

  it('reads a review from before kinds: every recommendation is a lesson', () => {
    const old = review([base]);
    expect(ManagerReview.safeParse(old).success).toBe(true);
    expect(TypedManagerReview.parse(old).recommendations).toEqual([{ ...base, kind: 'lesson' }]);
  });

  it('keeps the limit of three recommendations', () => {
    expect(TypedManagerReview.safeParse(review([base, { ...base, rank: 2 }, { ...base, rank: 3 }])).success).toBe(true);
    expect(TypedManagerReview.safeParse(review([base, base, base, base])).success).toBe(false);
  });
});

describe('who applies a change', () => {
  it('says so for every kind: the manager applies a lesson, a skill note and a retire; read tools and the model wait for the owner\'s code', () => {
    expect(Object.keys(MANAGER_APPLIES).sort()).toEqual([...ChangeKind.options].sort());
    // Ezra approved this in writing on 2026-10-27 (docs/manager.md, "Who decides what changes"). Changing it again is his
    // decision: this test is the tripwire.
    expect(MANAGER_APPLIES).toEqual({ lesson: true, skill_note: true, retire: true, reads: false, model: false });
  });
});

describe('RecommendationDetail', () => {
  it('holds the typed part and the reason the program did not apply it, and nothing else', () => {
    expect(RecommendationDetail.parse({})).toEqual({});
    expect(RecommendationDetail.parse({ reads: { add: ['my_lessons'] }, refused: 'because' })).toEqual({ reads: { add: ['my_lessons'], remove: [] }, refused: 'because' });
    expect(RecommendationDetail.parse({ retire: { target: 'note', text: 'Say the month.', why: 'Outdated.' } })).toEqual({ retire: { target: 'note', text: 'Say the month.', why: 'Outdated.' } });
    expect(RecommendationDetail.safeParse({ other: 1 }).success).toBe(false);
    expect(RecommendationDetail.safeParse({ refused: '' }).success).toBe(false);
  });
});
