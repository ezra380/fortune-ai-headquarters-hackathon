import { describe, expect, it } from 'vitest';
import { ANSWER_RULES, mentions, traceNumbers, untracedResultNumbers, writeAnswer } from '../src/answer.ts';
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
    expect(ANSWER_RULES).toMatch(/digits, never in words/);
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

  it('ignores years, dates, digits inside words and minutes written as min', () => {
    expect(traceNumbers('In September 2026 (2026-09-15) the 2nd and 3rd were busy at 4pm, 30min each.', { none: 0 })).toEqual([]);
    expect(traceNumbers('Revenue was 2026 dollars.', { none: 0 })).toEqual(['"2026" is not in the facts']);
    expect(traceNumbers('Revenue was $2026.', { none: 0 })).toEqual(['"$2026" is not in the facts']);
  });

  it('objects to numbers written in words, which cannot be checked', () => {
    expect(traceNumbers('Revenue was twelve thousand dollars.', facts)).toEqual(['"twelve thousand" is a number written in words; write it in digits so it can be checked']);
  });

  it('can also ask whether a reply states one particular value', () => {
    expect(mentions('Google earned $14,760.', 14760)).toBe(true);
    expect(mentions('Google earned $14.8k.', 14760)).toBe(true);
    expect(mentions('ROAS was 3.6x.', 3.6071)).toBe(true);
    expect(mentions('ROAS was 3.7x.', 3.6071)).toBe(false);
    expect(mentions('There were 3 no-shows.', 4)).toBe(false);
    expect(mentions('Nothing here.', 3)).toBe(false);
  });

  it('gives no objections for an empty reply', () => {
    expect(traceNumbers('', facts)).toEqual([]);
    expect(traceNumbers('I do not have that information.', facts)).toEqual([]);
  });
});

// ---- Review round: ways of writing a number that used to slip through -----------------------------

describe('traceNumbers: numbers written in words', () => {
  const probeFacts = { noShows: 7, washSet: 6200, amazonSpend: 2000 };
  const words = (w: string) => `"${w}" is a number written in words; write it in digits so it can be checked`;

  it.each([
    ['There were seven no-shows.', [words('seven')]],
    ['There were three no-shows and twelve cancellations.', [words('three'), words('twelve')]],
    ['Wash and set made sixty-two hundred dollars.', [words('sixty-two hundred')]],
    ['Amazon spent two thousand and fifty.', [words('two thousand and fifty')]],
    ['It was a dozen orders.', [words('dozen')]],
    ['Zero no-shows came back.', [words('Zero')]],
    ['Only one service sold.', [words('one')]],
  ])('objects to %j', (reply, objections) => {
    expect(traceNumbers(reply, probeFacts)).toEqual(objections);
  });

  it('does not mistake a scale word after a figure, or an ordinary use of "one", for a claim', () => {
    expect(traceNumbers('Revenue was $14.8 thousand, or $1.2 million.', { r: 14800, s: 1_200_000 })).toEqual([]);
    expect(traceNumbers('Revenue was 2 hundred.', { r: 200 })).toEqual([]);
    expect(traceNumbers('Revenue was 3 hundred.', { r: 3 })).toEqual(['"3 hundred" is not in the facts']);
    for (const idiom of [
      'No one called.', 'Which one sold best?', 'The one with the most revenue was color.', 'One of the services was color.', 'It is a one-time fee.',
      'Everyone phoned, someone left, nobody came, and the stone was none the worse.',
    ]) {
      expect(traceNumbers(idiom, probeFacts), idiom).toEqual([]);
    }
  });
});

describe('traceNumbers: a year is not a way round the facts', () => {
  const probeFacts = { noShows: 7, washSet: 6200, amazonSpend: 2000 };

  it('objects to an amount that only looks like a year', () => {
    expect(traceNumbers('Amazon had a spend of 1950 in September.', probeFacts)).toEqual(['"1950" is not in the facts']);
    expect(traceNumbers('Wash and set brought in 1999 last month.', probeFacts)).toEqual(['"1999" is not in the facts']);
    expect(traceNumbers('Orders for 1999 came in.', probeFacts)).toEqual(['"1999" is not in the facts']);
    // Even when the facts do name that year: there it is a date, not an amount.
    const dated = { ...probeFacts, period: '2026-09' };
    expect(traceNumbers('Wash and set brought in 2026 last month.', dated)).toEqual(['"2026" is not in the facts']);
    expect(traceNumbers('Amazon had a spend of 2026.', dated)).toEqual(['"2026" is not in the facts']);
  });

  it('accepts a year only in a real date context', () => {
    expect(traceNumbers('In September 2026 and Sept. 2026 and in May 2026 and Q3 2026.', { none: 0 })).toEqual([]);
    expect(traceNumbers('Sales in 2026 were steady.', { period: '2026-09' })).toEqual(['"2026" is not in the facts']); // "in" in the middle of a sentence is not a date
    expect(traceNumbers('In 2026, sales were steady.', { period: '2026-09' })).toEqual([]);
    expect(traceNumbers('Sales have grown since 2026.', { period: '2026-09' })).toEqual([]);
    expect(traceNumbers('In 2026, sales were steady.', { none: 0 })).toEqual(['"2026" is not in the facts']); // the facts never name that year
    expect(traceNumbers('Sales have grown since 2024.', { none: 0 }, 'How have sales done since 2024?')).toEqual([]); // the question names it
    expect(traceNumbers('The shop may 1950 times.', { none: 0 })).toEqual(['"1950" is not in the facts']); // the verb "may", not the month
  });
});

describe('traceNumbers: other ways of writing a number', () => {
  const probeFacts = { noShows: 7, washSet: 6200, amazonSpend: 2000 };

  it('reads a figure that starts with a decimal point', () => {
    expect(traceNumbers('Conversion was .9% for the month.', probeFacts)).toEqual(['".9%" is not in the facts']);
    expect(traceNumbers('Conversion was .9% for the month.', { conversion: 0.9 })).toEqual([]);
    expect(traceNumbers('Conversion was $.50 a click.', { cpc: 0.5 })).toEqual([]);
    expect(traceNumbers('ROAS was 3.6x, not .6x.', { roas: 3.6 })).toEqual(['".6x" is not in the facts']); // "3.6" is one figure, not "3" and ".6"
  });

  it('reads a lowercase m after a number as millions; minutes must be spelled min or minutes', () => {
    expect(traceNumbers('Revenue reached 30m this month.', probeFacts)).toEqual(['"30m" is not in the facts']);
    expect(traceNumbers('Revenue reached 30m this month.', { revenue: 30_000_000 })).toEqual([]);
    expect(traceNumbers('Revenue reached 3M and $4m.', { a: 3_000_000, b: 4_000_000 })).toEqual([]);
    expect(traceNumbers('Each takes 30min or 45minutes.', { none: 0 })).toEqual([]);
  });

  it('does not let a range hide inside something that looks like a date', () => {
    expect(traceNumbers('Spend ran 1000-20 last week.', probeFacts)).toEqual(['"1000" is not in the facts', '"20" is not in the facts']);
    expect(traceNumbers('Counts were 1500-12 and 2026-13.', { none: 0 })).toEqual([
      '"1500" is not in the facts', '"12" is not in the facts', '"2026" is not in the facts', '"13" is not in the facts',
    ]);
    expect(traceNumbers('Period 2026-09 and 2026-09-15 and 1999-12-31.', { none: 0 })).toEqual([]);
  });
});

// Merge wave 1, item b: the twin of the data lane's fix 4e. A row id names a row; its digits are not an amount.
describe('traceNumbers: row ids are names, not amounts', () => {
  const rowFacts = { rows: [{ invoice: 'SUP-2199', amountUsd: 400 }, { repair: 'demo-rt-01234', feeUsd: 85 }] };

  it('skips only the digits that close a row id (SUP-2201, demo-rt-01234), never a figure after a word and a hyphen', () => {
    expect(traceNumbers('Invoice SUP-2201 is overdue by $400.', rowFacts)).toEqual([]);
    expect(traceNumbers('Repair demo-rt-01234 (and demo-s-3) costs $85.', rowFacts)).toEqual([]);
    expect(traceNumbers('A high-35% margin and ROAS-9.5x.', rowFacts)).toEqual(['"35%" is not in the facts', '"9.5x" is not in the facts']);
    expect(traceNumbers('A sub-$5,000 test for the top-100 buyers.', rowFacts)).toEqual(['"$5,000" is not in the facts', '"100" is not in the facts']);
    expect(traceNumbers("SUP-2201's balance is $400.", rowFacts)).toEqual(['"2201" is not in the facts']); // glued: not an id
    expect(mentions('Invoice SUP-2201 is open.', 2201)).toBe(false);
  });
});

describe('traceNumbers: list numbers after any punctuation', () => {
  const listFacts = { google: { spend: 4100, revenue: 14760 }, amazon: { spend: 2000, revenue: 5000 } };

  it('ignores a list number on the line after a colon, an exclamation mark, a question mark or a bracket', () => {
    for (const lead of ['September ads:', 'Here you go!', 'Which did best?', 'Both did well (see below)', 'September ads.', 'September ads']) {
      const reply = `${lead}\n1. Google: $4,100 spend, $14,760 revenue\n2. Amazon: $2,000 spend, $5,000 revenue`;
      expect(traceNumbers(reply, listFacts), lead).toEqual([]);
    }
    expect(traceNumbers('Here you go!\n1) Google $4,100', listFacts)).toEqual([]);
    expect(traceNumbers('Ads:\n  - 1. Google $4,100\n\t2) Amazon $2,000', listFacts)).toEqual([]);
  });

  it('still objects to a number in a sentence, and to a figure that is not a list number', () => {
    expect(traceNumbers('September ads:\nThe top 2 were Google and Amazon.', listFacts)).toEqual(['"2" is not in the facts']);
    expect(traceNumbers('Ads:\n1.5 million views', listFacts)).toEqual(['"1.5 million" is not in the facts']);
    expect(traceNumbers('Ads:\n$ 4,100 and $ 17', listFacts)).toEqual(['"$ 17" is not in the facts']);
  });
});

describe('untracedResultNumbers', () => {
  const returned = [{ output: { metrics: [{ id: 'm:online.ads.google.spend', value: 4100 }, { id: 'm:online.ads.google.roas', value: 3.6071 }] } }];

  it('names each number in a script result that no tool returned', () => {
    expect(untracedResultNumbers({ spend: 4100, roas: 3.61, revenue: 99999 }, returned)).toEqual(['result.revenue (99999) was not returned by any tool']);
    expect(untracedResultNumbers({ rows: [{ value: 4100 }, { value: 7 }], note: 'about 12 of them' }, returned)).toEqual([
      'result.rows[1].value (7) was not returned by any tool',
      'result.note (12) was not returned by any tool',
    ]);
  });

  it('counts a tool number rounded to 0 to 2 decimals as returned, and nothing else', () => {
    expect(untracedResultNumbers({ roas: 3.6, again: 3.61, whole: 4, off: 3.7 }, returned)).toEqual(['result.off (3.7) was not returned by any tool']);
  });

  it('flags every number when no tool returned anything, and ignores text, booleans and null', () => {
    expect(untracedResultNumbers({ a: 1 }, [])).toEqual(['result.a (1) was not returned by any tool']);
    expect(untracedResultNumbers({ a: 'text only', b: true, c: null }, returned)).toEqual([]);
    expect(untracedResultNumbers(42, returned)).toEqual(['result (42) was not returned by any tool']);
  });
});
