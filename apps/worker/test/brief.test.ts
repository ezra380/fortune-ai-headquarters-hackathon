import { describe, expect, it, vi } from 'vitest';
import { DivisionBrief, type Attention, type DataPort, type Receipt } from '@fahq/contracts';
import { parseCommand } from '../src/commands.ts';
import type { WorkerDeps } from '../src/common.ts';
import {
  briefKey, briefSms, checkBrief, divisionData, fallbackBrief, isLiveNumber, mixedBusinessSentences, parseNeeds, replyMetrics, statusOf, type Reply,
} from '../src/brief.ts';
import { numberTrace } from '../src/reports.ts';
import type { DivisionBriefRow } from '../src/store.ts';
import { dataMock, mockMetrics } from './fixtures.ts';

// The parts of a division brief that need no database: where the numbers come from, the status rule, the
// checks on the writer's words, the fallback brief, the text to the head, and the APPROVE command.

const goodBrief = {
  headline: 'Google ads return 2.4x on $1,800 of spend.',
  findings: [
    { text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] },
    { text: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] },
  ],
  actions: [{ rank: 1, title: 'Hold Google spend', why: 'The return is 2.4x.', steps: 'Keep the budget and review the return next week.', cites: ['m:online.ads.google.roas'] }],
  ceoLine: 'Finance has something to watch.',
};
const none: Reply[] = [];
const src = { metrics: mockMetrics, attention: [] as Attention[], replies: none };
const objectionsOf = (raw: unknown, over: Partial<typeof src> = {}) => {
  const check = checkBrief(raw, { ...src, ...over });
  return check.ok ? [] : check.objections;
};

describe('where a division gets its numbers (divisionData)', () => {
  const receipts: Receipt[] = [];
  const depsWith = (data: DataPort | null) => ({
    data, period: '2026-09', live: false, now: () => new Date('2026-10-27T12:00:00Z'),
    store: { receipt: async (r: Receipt) => { receipts.push(r); } },
  }) as unknown as WorkerDeps;
  const task = { id: '11111111-1111-4111-8111-111111111111', assistant_id: 'salon', kind: 'scheduled', status: 'running', payload: {}, attempts: 1, max_attempts: 3 } as const;

  it('slices the finance read by business when the port has no division read: finance gets all, no attention', async () => {
    const finance = await divisionData(depsWith(dataMock), 'finance');
    expect(finance.metrics).toHaveLength(mockMetrics.length);
    expect(finance.attention).toEqual([]);
    expect((await divisionData(depsWith(dataMock), 'salon')).metrics.map((m) => m.business)).toEqual(['salon', 'salon']);
    expect((await divisionData(depsWith(dataMock), 'online')).metrics.map((m) => m.business)).toEqual(['online', 'online', 'online']);
  });

  it('uses the port\'s own division read, with its attention rules, when it has one', async () => {
    const attention: Attention[] = [{ metricId: 'm:salon.appointments.count', level: 'act', rule: 'bookings fell' }];
    const calls: unknown[] = [];
    const port: DataPort = {
      ...dataMock,
      getDivisionMetrics: async (input) => { calls.push(input); return { division: input.division, metrics: mockMetrics.slice(3), attention, queryHash: 'd'.repeat(64), view: 'fortune_demo_salon_mart' }; },
    };
    const read = await divisionData(depsWith(port), 'salon', { runId: 'r', task: task as never });
    expect(read.attention).toEqual(attention);
    expect(calls).toEqual([{ division: 'salon', period: '2026-09', asOf: '2026-10-27T12:00:00.000Z' }]);
    expect(receipts.at(-1)).toMatchObject({ step: 'brief.data', assistantId: 'salon', outcome: 'ok', dataSource: 'zetaris:fortune_demo_salon_mart#dddddddddddd' });
  });

  it('says so, with a failed receipt, when the data is not connected, empty, unreadable or for another division', async () => {
    const fails = async (port: DataPort | null) => divisionData(depsWith(port), 'salon', { runId: 'r', task: task as never }).then(() => 'read', (e: Error) => e.message);
    expect(await fails(null)).toBe('business data (packages/data) is not connected');
    expect(await fails({ ...dataMock, getFinanceMetrics: async () => ({ metrics: [], queryHash: 'c'.repeat(64), view: 'v' }) })).toBe('the data source returned no metrics for the salon division');
    // Merge wave 1, item c (the brief lane's twin): the provider's own text goes to the log, never to the receipt or the error.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await fails({ ...dataMock, getFinanceMetrics: async () => { throw new Error('HTTP 500: AnalysisException on zetaris-node-7.internal'); } })).toBe('Business data could not be read (ZETARIS_READ).');
    expect(await fails({ ...dataMock, getDivisionMetrics: async () => { throw new Error('HTTP 502: <html>bad gateway</html>'); } })).toBe('Business data could not be read (ZETARIS_READ).');
    expect(receipts.slice(-2).map((r) => r.detail)).toEqual(Array(2).fill('Business data could not be read (ZETARIS_READ).'));
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^worker\.zetaris_read_failed Error: HTTP 500/), expect.stringMatching(/^worker\.zetaris_read_failed Error: HTTP 502/)]);
    log.mockRestore();
    expect(await fails({ ...dataMock, getDivisionMetrics: async () => ({ division: 'online', metrics: mockMetrics, attention: [], queryHash: 'c'.repeat(64), view: 'v' }) })).toBe('the data source answered for the online division, not salon');
    expect(receipts.slice(-4).map((r) => [r.step, r.outcome])).toEqual(Array(4).fill(['brief.data', 'failed']));
  });
});

describe('statusOf: the program, never a model, sets the status', () => {
  it('is act if any rule says act, else watch if any says watch, else normal', () => {
    const rule = (level: 'watch' | 'act'): Attention => ({ metricId: 'm:salon.appointments.count', level, rule: 'x' });
    expect(statusOf([])).toBe('normal');
    expect(statusOf([rule('watch')])).toBe('watch');
    expect(statusOf([rule('watch'), rule('act'), rule('watch')])).toBe('act');
  });
});

describe('parseNeeds: what a division may ask the others', () => {
  it('keeps valid questions to other divisions, one per division, at most two', () => {
    const q = (division: string, question = 'How many appointments?') => ({ division, question });
    expect(parseNeeds({ requests: [q('salon'), q('salon', 'again'), q('finance'), q('online')] }, 'online').requests.map((r) => r.division)).toEqual(['salon', 'finance']);
  });

  it('drops a question to itself or to hq, and anything that is not a valid request', () => {
    const out = parseNeeds({ requests: [{ division: 'online', question: 'me?' }, { division: 'hq', question: 'ceo?' }, { division: 'salon' }, 'nope', { division: 'finance', question: '' }] }, 'online');
    expect(out).toEqual({ requests: [], unusable: null, dropped: [] });
  });

  it('drops a question with medical or hair-loss wording, a phone number or a six-digit code, and names why (never the words)', () => {
    const asked = (question: string) => parseNeeds({ requests: [{ division: 'salon', question }] }, 'online');
    expect(asked('How many hair loss clients booked toppers?')).toEqual({ requests: [], unusable: null, dropped: ['medical wording'] });
    for (const text of ['Any alopecia customers?', 'Do chemo patients book more?', 'How many medical wigs sold?', 'Hair-loss share of bookings?', 'A diagnosis list?', 'Customers with cancer?']) {
      expect(asked(text).dropped, text).toEqual(['medical wording']);
    }
    for (const text of ['Call 212-555-0123 first', 'Text (212) 555-0123 now', 'Is +1 212 555 0123 a client?', 'ring 2125550123', 'ring 212.555.0123', 'ring 12125550123']) {
      expect(asked(text).dropped, text).toEqual(['a phone number']);
    }
    for (const text of ['The code is 482913, ok?', 'Use 482913']) expect(asked(text).dropped, text).toEqual(['a code']);
    expect(asked('Hair loss: call 212-555-0123').dropped).toEqual(['medical wording']); // one reason a question
  });

  it('keeps a plain question with dates, amounts and small numbers in it', () => {
    for (const question of [
      'How many appointments did the salon book between 2026-09-01 and 2026-09-30?', 'What was revenue above $12,400 in the last 30 days?',
      'Did bookings rise 15% to 310 from 2026-09?', 'Which 3 services earned the most (top 5)?', 'Was revenue 1234567 or more?',
    ]) {
      expect(parseNeeds({ requests: [{ division: 'salon', question }] }, 'online'), question).toEqual({ requests: [{ division: 'salon', question }], unusable: null, dropped: [] });
    }
  });

  it('keeps the other question when one is dropped, and still counts a dropped question to a division already asked', () => {
    const out = parseNeeds({ requests: [
      { division: 'salon', question: 'How many appointments?' }, { division: 'salon', question: 'And the patient list?' }, { division: 'finance', question: 'Text 212-555-0123' }, { division: 'finance', question: 'What did ads return?' },
    ] }, 'online');
    expect(out.requests.map((r) => r.question)).toEqual(['How many appointments?', 'What did ads return?']);
    expect(out.dropped).toEqual(['medical wording', 'a phone number']);
  });

  it('says when the answer has no list at all', () => {
    expect(parseNeeds({ answer: 'none' }, 'salon').unusable).toBe('the answer had no "requests" list');
    expect(parseNeeds(null, 'salon').unusable).toBe('the answer had no "requests" list');
  });
});

describe('checkBrief: the rules a schema cannot state', () => {
  it('accepts a brief whose numbers, ids and sentences all check out, ranks sorted', () => {
    const check = checkBrief({ ...goodBrief, actions: [{ ...goodBrief.actions[0]!, rank: 2 }, { ...goodBrief.actions[0]!, rank: 1, title: 'First' }] }, src);
    expect(check.ok && check.brief.actions.map((a) => a.rank)).toEqual([1, 2]);
  });

  it('renumbers the actions 1, 2, 3 in order when the model leaves a gap, so the ranks the head is told to use exist', () => {
    const gapped = { ...goodBrief, actions: [{ ...goodBrief.actions[0]!, rank: 3, title: 'Third' }, { ...goodBrief.actions[0]! }] };
    const check = checkBrief(gapped, src);
    expect(check.ok && check.brief.actions.map((a) => [a.rank, a.title])).toEqual([[1, 'Hold Google spend'], [2, 'Third']]);
    // A repeated rank is still an objection, not something to renumber.
    expect(objectionsOf({ ...goodBrief, actions: [goodBrief.actions[0]!, { ...goodBrief.actions[0]!, title: 'Other' }] })).toEqual(['action ranks must be different: rank each one 1, 2 or 3, once']);
  });

  it('drops a status the model adds: the status is not part of a brief', () => {
    const check = checkBrief({ ...goodBrief, status: 'normal' }, src);
    expect(check.ok && 'status' in check.brief).toBe(false);
  });

  it('refuses a number that is not in the data, in any field', () => {
    expect(objectionsOf({ ...goodBrief, headline: 'Spend reached $9,999 on Google.' })).toEqual(['headline: "9,999" is not a number in the data']);
    expect(objectionsOf({ ...goodBrief, ceoLine: 'Sales are up 40%.' })).toEqual(['ceoLine: "40%" is not a number in the data']);
    expect(objectionsOf({ ...goodBrief, actions: [{ ...goodBrief.actions[0]!, steps: 'Call 5551234567 today.' }] }).join()).toContain('is not a number in the data');
  });

  it('refuses the words one, two and three, and larger number words', () => {
    expect(objectionsOf({ ...goodBrief, headline: 'One thing to watch.' })).toEqual(['headline: "One" is not a number in the data']);
    expect(objectionsOf({ ...goodBrief, headline: 'Twelve things to watch.' })[0]).toContain('write "Twelve" in digits');
  });

  it('refuses a cited metric id that does not exist, but accepts one inside a reply it was given', () => {
    const cited = { ...goodBrief, findings: [{ text: 'The salon booked 310 appointments.', cites: ['m:salon.no_shows.count'] }] };
    expect(objectionsOf(cited)).toEqual(['finding 1: "m:salon.no_shows.count" is not a metric id in the data you were given']);
    const reply: Reply = { from: 'salon', question: 'q', ok: true, facts: { metrics: { 'm:salon.no_shows.count': { label: 'Salon no-shows', value: 310, unit: 'count', business: 'salon' } } }, reason: null };
    expect(objectionsOf(cited, { replies: [reply] })).toEqual([]);
  });

  it('refuses two actions with the same rank, a headline that is too long and a missing field', () => {
    const twice = { ...goodBrief, actions: [goodBrief.actions[0]!, { ...goodBrief.actions[0]!, title: 'Other' }] };
    expect(objectionsOf(twice)).toEqual(['action ranks must be different: rank each one 1, 2 or 3, once']);
    expect(objectionsOf({ ...goodBrief, headline: 'x'.repeat(161) })[0]).toContain('headline');
    expect(objectionsOf({ ...goodBrief, ceoLine: undefined })[0]).toContain('ceoLine');
    expect(objectionsOf({ ...goodBrief, actions: [{ ...goodBrief.actions[0]!, rank: 4 }] })[0]).toContain('actions.0.rank');
  });

  it('refuses a sentence that puts a salon number next to an online number, but not two sentences', () => {
    const mixed = { ...goodBrief, headline: 'Mazali brought in $12,400 while the salon booked 310 appointments.' };
    expect(objectionsOf(mixed)).toEqual(['headline: one sentence mixes a salon number and an online number (12,400, 310)']);
    expect(objectionsOf({ ...goodBrief, headline: 'Mazali brought in $12,400. The salon booked 310 appointments.' })).toEqual([]);
  });

  it('uses the business of the metric inside a reply, so a salon fact cannot be mixed into an online sentence', () => {
    const reply: Reply = { from: 'salon', question: 'q', ok: true, facts: { rows: [{ id: 'm:salon.appointments.count', value: 310 }] }, reason: null };
    const online = mockMetrics.filter((m) => m.business === 'online');
    const text = 'Mazali brought in $12,400 and the salon booked 310 appointments.';
    expect(objectionsOf({ ...goodBrief, headline: text }, { metrics: online, replies: [reply] })).toEqual(['headline: one sentence mixes a salon number and an online number (12,400, 310)']);
  });

  describe("another division's numbers count only as metric values with an id", () => {
    const online = mockMetrics.filter((m) => m.business === 'online');
    const ownOnly = { ...goodBrief, findings: [goodBrief.findings[0]!] }; // a brief that rests on online numbers alone
    const reply = (from: Reply['from'], facts: unknown): Reply => ({ from, question: 'q', ok: true, facts, reason: null });

    it('refuses a number from a reply that carries no metric id: a finance total, or a salon count with no id', () => {
      expect(objectionsOf({ ...ownOnly, headline: 'Revenue was $18,600 across the business.' }, { metrics: online, replies: [reply('finance', { total: 18600 })] }))
        .toEqual(['headline: "18,600" is not a number in the data']);
      expect(objectionsOf({ ...ownOnly, headline: 'Mazali brought in $12,400 and the salon booked 310 appointments.' }, { metrics: online, replies: [reply('salon', { appointments: 310 })] }))
        .toEqual(['headline: "310" is not a number in the data']);
    });

    it('does not take a number written inside the words of a reply', () => {
      const words = reply('salon', { rows: [{ id: 'm:salon.appointments.count', value: 310, label: 'Appointments in the last 45 days' }] });
      expect(objectionsOf({ ...ownOnly, headline: 'The salon booked 310 appointments in 45 days.' }, { metrics: online, replies: [words] })).toEqual(['headline: "45" is not a number in the data']);
    });

    it('knows an id from a reply only when it comes with a number, and only in the business that answered', () => {
      const cited = { ...ownOnly, findings: [{ text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:salon.no_shows.count'] }] };
      expect(objectionsOf(cited, { metrics: online, replies: [reply('salon', { note: 'see m:salon.no_shows.count' })] })).toEqual(['finding 1: "m:salon.no_shows.count" is not a metric id in the data you were given']);
      expect(objectionsOf(cited, { metrics: online, replies: [reply('online', { 'm:salon.no_shows.count': 4 })] })).toHaveLength(1); // an online answer cannot hand over a salon number
      expect(objectionsOf(cited, { metrics: online, replies: [reply('salon', { 'm:salon.no_shows.count': 4 })] })).toEqual([]);
    });
  });

  it('refuses medical and hair-loss words', () => {
    expect(objectionsOf({ ...goodBrief, headline: 'Customers with hair loss booked more.' })).toEqual(['headline: no medical or hair-loss information belongs in a brief']);
    expect(objectionsOf({ ...goodBrief, ceoLine: 'A medical wig line sells well.' })[0]).toContain('no medical or hair-loss');
  });

  it('mixedBusinessSentences ignores numbers that belong to both businesses or to neither', () => {
    const values = [{ value: 310, business: 'salon' }, { value: 12400, business: 'online' }, { value: 5, business: 'salon' }, { value: 5, business: 'online' }];
    expect(mixedBusinessSentences('x', 'The salon had 5 and the online store had 12,400.', values)).toEqual([]);
    expect(mixedBusinessSentences('x', 'The salon had 310 and online made 12,400.', values)).toHaveLength(1);
    expect(mixedBusinessSentences('x', 'The salon had 310 visits in 99 days.', values)).toEqual([]);
  });
});

describe('replyMetrics: the only numbers another division can hand over', () => {
  it('reads an id with its number whether it is listed, keyed with a value or keyed with a bare number; a unit is kept only when it is one of ours', () => {
    expect(replyMetrics({ rows: [{ id: 'm:salon.appointments.count', value: 310, unit: 'count', label: 'Appointments (30 days)' }] }, 'salon'))
      .toEqual([{ id: 'm:salon.appointments.count', value: 310, unit: 'count' }]);
    expect(replyMetrics({ metrics: { 'm:salon.appointments.count': { value: 310, unit: 'weeks', business: 'salon' } } }, 'salon')).toEqual([{ id: 'm:salon.appointments.count', value: 310 }]);
    expect(replyMetrics({ 'm:salon.revenue.wash_set': 6200 }, 'salon')).toEqual([{ id: 'm:salon.revenue.wash_set', value: 6200 }]);
    expect(replyMetrics([{ id: 'm:online.ads.google.roas', value: 2.4, unit: 'ratio' }], 'online')).toEqual([{ id: 'm:online.ads.google.roas', value: 2.4, unit: 'ratio' }]);
  });

  it('drops every number without an id, every word, and anything that is not a finite number', () => {
    const facts = { total: 18600, note: 'booked 310', 'm:salon.a': '5', rows: [{ id: 'm:salon.b', value: null }, { id: 'm:salon.c', value: Number.POSITIVE_INFINITY }, { id: 'M:salon.d', value: 1 }, { id: 'm:salon.e e', value: 1 }, { id: 7, value: 1 }] };
    expect(replyMetrics(facts, 'salon')).toEqual([]);
    expect(replyMetrics('m:salon.x 3', 'salon')).toEqual([]);
    expect(replyMetrics(null, 'salon')).toEqual([]);
  });

  it('keeps to the business that answered: salon gets salon ids, online online ids, finance both, and combined never', () => {
    const facts = { rows: [{ id: 'm:salon.appointments.count', value: 310 }, { id: 'm:online.revenue.mazali', value: 12400 }, { id: 'm:combined.cash', value: 5 }] };
    expect(replyMetrics(facts, 'salon').map((m) => m.id)).toEqual(['m:salon.appointments.count']);
    expect(replyMetrics(facts, 'online').map((m) => m.id)).toEqual(['m:online.revenue.mazali']);
    expect(replyMetrics(facts, 'finance').map((m) => m.id)).toEqual(['m:salon.appointments.count', 'm:online.revenue.mazali']);
  });

  it('keeps one entry for the same id and value, is capped, and does not read below eight levels', () => {
    expect(replyMetrics([{ id: 'm:salon.x', value: 1 }, { id: 'm:salon.x', value: 1 }, { id: 'm:salon.x', value: 2 }], 'salon').map((m) => m.value)).toEqual([1, 2]);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m:salon.n${i}`, value: i }));
    expect(replyMetrics(many, 'salon')).toHaveLength(40);
    let deep: unknown = { id: 'm:salon.deep', value: 1 };
    for (let i = 0; i < 12; i++) deep = { inner: deep };
    expect(replyMetrics(deep, 'salon')).toEqual([]);
  });
});

describe('fallbackBrief: written by rules from the attention list and the metrics\' own labels and values', () => {
  const attention: Attention[] = [
    { metricId: 'm:salon.appointments.count', level: 'watch', rule: 'bookings below plan' },
    { metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' },
  ];

  it('is marked in its headline, lists what fired (act first), proposes only for act, and passes the schema and the number trace', () => {
    const brief = fallbackBrief('Finance', { metrics: mockMetrics, attention }, 'act');
    expect(DivisionBrief.safeParse(brief).success).toBe(true);
    expect(brief.headline).toBe('Rule-written brief, because the usual write-up did not pass its number check. Status: act.');
    expect(brief.findings.map((f) => f.text)).toEqual([
      'Google ad return is 2.40x. Rule that fired (act): return below target',
      'Salon appointments is 310. Rule that fired (watch): bookings below plan',
    ]);
    expect(brief.findings.map((f) => f.cites)).toEqual([['m:online.ads.google.roas'], ['m:salon.appointments.count']]);
    expect(brief.actions).toHaveLength(1);
    expect(brief.actions[0]).toMatchObject({ rank: 1, title: 'Look at Google ad return', cites: ['m:online.ads.google.roas'] });
    expect(brief.ceoLine).toBe('Finance needs a decision from its head.');
    const texts = [['headline', brief.headline], ...brief.findings.map((f, i) => [`f${i}`, f.text] as const), ['ceo', brief.ceoLine]] as const;
    expect(numberTrace(texts, { metrics: mockMetrics, attention })).toEqual([]);
  });

  it('with nothing fired, shows the first metrics as read and says no rule fired; status words follow the status', () => {
    const quiet = fallbackBrief('Salon', { metrics: mockMetrics, attention: [] }, 'normal');
    expect(quiet.findings).toHaveLength(3);
    expect(quiet.findings[0]!.text).toBe('Online Mazali revenue is $12,400. No rule fired on it.');
    expect(quiet.actions).toEqual([]);
    expect(quiet.ceoLine).toBe('Salon is running normally.');
    expect(fallbackBrief('Online', { metrics: mockMetrics, attention: [attention[0]!] }, 'watch').ceoLine).toBe('Online has something to watch; its head has the detail.');
  });

  it('names an attention rule whose metric is not in the data by its id, without citing it', () => {
    const brief = fallbackBrief('Finance', { metrics: mockMetrics, attention: [{ metricId: 'm:online.gone', level: 'act', rule: 'x' }] }, 'act');
    expect(brief.findings[0]).toEqual({ text: 'm:online.gone. Rule that fired (act): x', cites: [] });
    expect(DivisionBrief.safeParse(brief).success).toBe(true);
  });
});

describe('the text to the head', () => {
  const row = (brief: DivisionBrief, over: Partial<DivisionBriefRow> = {}): DivisionBriefRow => ({
    id: 'b', division: 'finance', brief_key: 'brief:finance:2026-10-27', brief_date: '2026-10-27', period: '2026-09', status: 'watch', written_by: 'model',
    brief, ceo_line: brief.ceoLine, data_source: null, task_id: null, created_at: '2026-10-27T12:00:00Z', ...over,
  });
  const tail = 'Reply APPROVE <1-3> 482913 to approve an action. The code expires in 12 hours.';

  it('carries the status, headline, findings and actions, then the tail', () => {
    const sms = briefSms(row(goodBrief as DivisionBrief), 'Finance', tail);
    expect(sms).toBe([
      'George: Finance brief for 2026-10-27 (status WATCH)',
      goodBrief.headline,
      'Findings:',
      `- ${goodBrief.findings[0]!.text}`,
      `- ${goodBrief.findings[1]!.text}`,
      'Actions:',
      'Action 1: Hold Google spend - The return is 2.4x.',
      tail,
    ].join('\n'));
  });

  it('says so when a program wrote the brief', () => {
    const sms = briefSms(row(fallbackBrief('Finance', { metrics: mockMetrics, attention: [] }, 'normal'), { written_by: 'rule', status: 'normal' }), 'Finance', 'Nothing needs your approval today.');
    expect(sms.split('\n')[0]).toBe('George: Finance brief for 2026-10-27 (status NORMAL) - written by rules: the usual write-up did not pass its number check');
  });

  it('starts with the name of the division\'s manager, whoever the head is', () => {
    const first = (division: DivisionBriefRow['division'], label: string) =>
      briefSms(row(goodBrief as DivisionBrief, { division }), label, tail).split('\n')[0];
    expect(first('finance', 'Finance')).toBe('George: Finance brief for 2026-10-27 (status WATCH)');
    expect(first('online', 'Online')).toBe('Georgette: Online brief for 2026-10-27 (status WATCH)');
    expect(first('salon', 'Salon')).toBe('Cindy: Salon brief for 2026-10-27 (status WATCH)');
  });

  it('shortens to fit one message and never loses the tail', () => {
    const long = DivisionBrief.parse({
      headline: 'h'.repeat(160),
      findings: Array.from({ length: 4 }, () => ({ text: 'f'.repeat(300), cites: [] })),
      actions: [1, 2, 3].map((rank) => ({ rank, title: 't'.repeat(80), why: 'w'.repeat(300), steps: 's'.repeat(300), cites: [] })),
      ceoLine: 'c'.repeat(140),
    });
    const sms = briefSms(row(long), 'Finance', tail);
    expect(sms.length).toBeLessThanOrEqual(1600);
    expect(sms.endsWith(`\n${tail}`)).toBe(true);
    expect(sms).toContain('Action 3: ');
    expect(sms).not.toContain('www');
  });
});

describe('small rules', () => {
  it('a number is live unless it is missing or a +1555 placeholder', () => {
    expect(isLiveNumber(null)).toBe(false);
    expect(isLiveNumber('+15550100002')).toBe(false);
    expect(isLiveNumber('+12125550123')).toBe(true);
    expect(isLiveNumber('212-555-0123')).toBe(false);
  });

  it('the brief key names the division and the day', () => {
    expect(briefKey('online', '2026-10-27')).toBe('brief:online:2026-10-27');
  });

  it('a brief asked for by text is a run of its own: the key adds the id of that text\'s task', () => {
    const request = '123e4567-e89b-42d3-a456-426614174000';
    expect(briefKey('online', '2026-10-27', request)).toBe(`brief:online:2026-10-27:${request}`);
  });

  it('reads APPROVE <ranks> <code> exactly (ranks 1-3, each once, like ADOPT), and keeps near-misses away from any model', () => {
    expect(parseCommand('approve 2 482913')).toEqual({ kind: 'approve', ranks: [2], code: '482913' });
    expect(parseCommand('  APPROVE   1   654321 ')).toEqual({ kind: 'approve', ranks: [1], code: '654321' });
    expect(parseCommand('APPROVE 1 2 482913')).toEqual({ kind: 'approve', ranks: [1, 2], code: '482913' });
    expect(parseCommand('Approve 3,1 482913')).toEqual({ kind: 'approve', ranks: [1, 3], code: '482913' }); // sorted
    expect(parseCommand('approve 1, 2, 3 654321')).toEqual({ kind: 'approve', ranks: [1, 2, 3], code: '654321' });
    for (const t of [
      'APPROVE', 'approve 2', 'APPROVE 4 482913', 'APPROVE 0 482913', 'APPROVE 1 48291', 'approve it', 'APPROVE 1 1 482913', 'APPROVE 1 2 3 1 482913',
      'APPROVE 1 2', 'APPROVE 482913', 'please approve 2 482913 thanks',
    ]) {
      expect(parseCommand(t)?.kind, t).toBe('malformed');
    }
    expect(parseCommand('Approve the evening slots idea')).toBeNull();
    expect((parseCommand('yes') as { hint: string }).hint).toContain('APPROVE 1 2 <code>');
  });

  it('does not read a command out of a longer text, a second command, a stray separator or full-width digits', () => {
    for (const t of [
      'APPROVE 1 2 482913\nSEND 1 482913', 'APPROVE 1 2 482913 482913', 'APPROVE 1,,2 482913', 'APPROVE 1;2 482913', 'APPROVE 1 2,482913',
      'APPROVE １ 482913', 'APPROVE 1 ４８２９１３', '/APPROVE 1 482913', 'APPROVE: 1 482913',
    ]) {
      expect(parseCommand(t)?.kind, t).not.toBe('approve');
    }
  });

  it('reads BRIEF exactly, and lets a request that mentions a brief through to the router', () => {
    expect(parseCommand('brief')).toEqual({ kind: 'brief' });
    expect(parseCommand('  BRIEF ')).toEqual({ kind: 'brief' });
    for (const t of ['Brief me on the salon', 'BRIEF 123456', 'write a brief for finance', 'briefs']) expect(parseCommand(t), t).toBeNull();
  });

  it('the brief schema holds the sizes the head can read', () => {
    expect(DivisionBrief.safeParse(goodBrief).success).toBe(true);
    expect(DivisionBrief.safeParse({ ...goodBrief, findings: Array(5).fill(goodBrief.findings[0]) }).success).toBe(false);
    expect(DivisionBrief.safeParse({ ...goodBrief, actions: Array(4).fill(goodBrief.actions[0]) }).success).toBe(false);
    expect(DivisionBrief.safeParse({ ...goodBrief, ceoLine: 'c'.repeat(141) }).success).toBe(false);
    expect(DivisionBrief.safeParse({ ...goodBrief, findings: [{ text: 'x', cites: ['not-an-id'] }] }).success).toBe(false);
  });
});
