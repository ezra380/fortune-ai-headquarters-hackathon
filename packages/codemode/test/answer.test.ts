import { describe, expect, it } from 'vitest';
import { ANSWER_RULES, traceNumbers, writeAnswer } from '../src/answer.ts';
import { mockModel } from './model.mock.ts';

const facts = { google: { spend: 4100, revenue: 14760, roas: 3.6071 }, ratio: 0.4231, services: [{ name: 'Wash and set', revenue: 6200 }], noShows: 3, period: '2026-09' };

describe('writeAnswer', () => {
  it('asks for a short text reply from the facts only, and reports tokens', async () => {
    const { model, calls } = mockModel(['  Google earned $14,760 on $4,100 of spend.  ']);
    const r = await writeAnswer({ model, modelId: 'test/answer-model', skill: '# Owner HQ\nYou are read-only.', question: 'How did Google do?', facts });
    expect(r).toEqual({ text: 'Google earned $14,760 on $4,100 of spend.', inputTokens: 100, outputTokens: 20, model: 'test/answer-model' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'answer', model: 'test/answer-model', maxTokens: 400, temperature: 0.2, json: false, thinking: false });
    expect(calls[0]!.system).toBe(`# Owner HQ\nYou are read-only.\n\n## How to answer\n${ANSWER_RULES}`);
    expect(ANSWER_RULES).toMatch(/at most 3 short sentences/);
    expect(ANSWER_RULES).toMatch(/Use only the facts given\. Every number must come from the facts/);
    expect(ANSWER_RULES).toMatch(/say so plainly/);
    expect(JSON.parse(calls[0]!.user)).toEqual({ question: 'How did Google do?', facts });
  });

  it('takes its own token limit and receipt name, and refuses an empty answer', async () => {
    const { model, calls } = mockModel(['Fine.', '   ']);
    await writeAnswer({ model, modelId: 'm', skill: 's', question: 'q', facts: {}, maxTokens: 150, purpose: 'owner.answer' });
    expect(calls[0]).toMatchObject({ maxTokens: 150, purpose: 'owner.answer' });
    await expect(writeAnswer({ model, modelId: 'm', skill: 's', question: 'q', facts: {} })).rejects.toThrow(/empty answer/);
  });

  it('lets a model failure through, so the caller decides', async () => {
    const { model } = mockModel([new Error('provider down')]);
    await expect(writeAnswer({ model, modelId: 'm', skill: 's', question: 'q', facts: {} })).rejects.toThrow('provider down');
  });
});

describe('traceNumbers', () => {
  it('passes a reply whose numbers all come from the facts', () => {
    expect(traceNumbers('Google spent $4,100 and earned $14,760, a ROAS of 3.6x. Wash and set made $6,200 and there were 3 no-shows.', facts)).toEqual([]);
  });

  it('names each number that is not in the facts, once', () => {
    expect(traceNumbers('Amazon earned $9,999 and then $9,999 again, plus 17 orders.', facts)).toEqual(['"$9,999" is not in the facts', '"17" is not in the facts']);
  });

  it('accepts a fact rounded to the precision the reply uses, and nothing else', () => {
    for (const ok of ['3.6x', '3.61x', '4x', '3.607x']) expect(traceNumbers(`ROAS was ${ok}.`, facts), ok).toEqual([]);
    for (const bad of ['3.7x', '3.5x', '3.62x', '5x']) expect(traceNumbers(`ROAS was ${bad}.`, facts), bad).toEqual([`"${bad}" is not in the facts`]);
    expect(traceNumbers('Revenue was $14,760.4.', { revenue: 14760.4 })).toEqual([]);
    expect(traceNumbers('Revenue was $14,761.', { revenue: 14760.4 })).toEqual(['"$14,761" is not in the facts']);
  });

  it('treats a percentage and a ratio times 100 as the same number', () => {
    expect(traceNumbers('Open rate was 42%.', facts)).toEqual([]);
    expect(traceNumbers('Open rate was 42.3%.', facts)).toEqual([]);
    expect(traceNumbers('Open rate was 43%.', facts)).toEqual(['"43%" is not in the facts']);
    expect(traceNumbers('Open rate was 42.3 percent.', { open: 42.3 })).toEqual([]);
    expect(traceNumbers('Open rate was 0.42.', facts)).toEqual([]);
  });

  it('reads thousands and millions, and ignores signs', () => {
    expect(traceNumbers('Revenue was $14.8k.', facts)).toEqual([]);
    expect(traceNumbers('Revenue was 14.76 thousand dollars... or $4.1k of spend.', facts)).toEqual([]);
    expect(traceNumbers('Revenue was $1.2M.', { r: 1_200_000 })).toEqual([]);
    expect(traceNumbers('A loss of $300 and a gain of -$300.', { delta: -300 })).toEqual([]);
  });

  it('finds numbers anywhere in nested facts, including inside strings', () => {
    expect(traceNumbers('The service had 12 tickets.', { deep: { list: [{ note: 'tickets: 12' }] } })).toEqual([]);
    expect(traceNumbers('The service had 13 tickets.', { deep: { list: [{ note: 'tickets: 12' }] } })).toEqual(['"13" is not in the facts']);
    expect(traceNumbers('Nothing to check.', null)).toEqual([]);
    expect(traceNumbers('It was $5.', undefined)).toEqual(['"$5" is not in the facts']);
  });

  it('ignores list numbers at the start of a line, but not numbers in a sentence', () => {
    const reply = '1. Wash and set\n2) Color\n  3. Cut';
    expect(traceNumbers(reply, { services: [] })).toEqual([]);
    expect(traceNumbers('The top 2 services were wash and set.', { services: [] })).toEqual(['"2" is not in the facts']);
    expect(traceNumbers('Revenue is $1.5k\n2. next', { r: 1500 })).toEqual([]);
  });

  it('ignores years, dates, digits inside words and minutes', () => {
    expect(traceNumbers('In September 2026 (2026-09-15) the 2nd and 3rd were busy at 4pm, 30m each.', { none: 0 })).toEqual([]);
    expect(traceNumbers('Revenue was 2026 dollars.', { none: 0 })).toEqual(['"2026" is not in the facts']);
    expect(traceNumbers('Revenue was $2026.', { none: 0 })).toEqual(['"$2026" is not in the facts']);
  });

  it('objects to numbers written in words, which cannot be checked', () => {
    expect(traceNumbers('Revenue was twelve thousand dollars.', facts)).toEqual(['"twelve thousand" is a number written in words; write it in digits so it can be checked']);
  });

  it('gives no objections for an empty reply', () => {
    expect(traceNumbers('', facts)).toEqual([]);
    expect(traceNumbers('I do not have that information.', facts)).toEqual([]);
  });
});
