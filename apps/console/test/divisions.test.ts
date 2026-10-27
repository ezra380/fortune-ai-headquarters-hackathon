import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPARTMENTS } from '../src/departments.ts';
import type { RawDepartment } from '../src/departments.ts';
import type { BriefDivision, DivisionsView, RawBriefRow, RawDivisionState, RawDivisions, RawReply, RawRequest } from '../src/divisions.ts';
import { createDivisionsLoader } from '../src/loader.ts';
import { startConsoleServer } from '../src/server.ts';
import type { RunningConsole } from '../src/server.ts';
import { shapeDepartment, shapeDivisions } from '../src/shape.ts';
import { drawTab } from './draw.ts';
import { recorder, type Call } from './recorder.ts';

// The Divisions view: shaping, the loader against a recording fake, the server and the page. No network, no database
// (divisions-db.test.ts reads the real local database). Every data source here is a fake the test injects.

const NOW = new Date('2026-10-27T13:30:00.000Z'); // 09:30 in New York
const SECRET_LOOKING = [/service_role/i, /sb_secret/i, /sb_publishable/i, /eyJ/, /code_hash/i, /\b[0-9a-f]{40,}\b/i, /SUPABASE_/];
const PHONE_LIKE = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/;

// ---- Fixtures ---------------------------------------------------------------------------------------------

const financeBrief = {
  headline: 'Google ads return 2.4x on $1,800 of spend.',
  findings: [
    { text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] },
    { text: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] },
  ],
  actions: [
    { rank: 1, title: 'Hold Google spend', why: 'The return is 2.4x on $1,800 of spend.', steps: 'Keep the budget and review next week.', cites: ['m:online.ads.google.roas'] },
    { rank: 2, title: 'Check Mazali stock', why: 'Stock is running low.', steps: 'Count the shelf.', cites: [] },
    { rank: 3, title: 'Call the supplier', why: 'A delivery is late.', steps: 'Phone on Monday.', cites: [] },
  ],
  ceoLine: 'Finance has something to watch; its head has the detail.',
};
const salonBrief = {
  headline: 'The salon booked 310 appointments.',
  findings: [{ text: 'Wash and set brought in $6,200.', cites: ['m:salon.revenue.wash_set'] }],
  actions: [],
  ceoLine: 'Salon is running normally.',
};
const onlineBrief = {
  headline: 'Mazali brought in $12,400 online.',
  findings: [{ text: 'Mazali brought in $12,400 online.', cites: ['m:online.revenue.mazali'] }],
  actions: [{ rank: 1, title: 'Add a booking link', why: 'Buyers have room to book.', steps: 'Add the link to the order email.', cites: [] }],
  ceoLine: 'Online is running normally.',
};
const BRIEFS: Record<BriefDivision, typeof financeBrief> = { salon: salonBrief as never, finance: financeBrief, online: onlineBrief as never };

const row = (division: BriefDivision, over: Partial<RawBriefRow> = {}): RawBriefRow => ({
  division,
  brief_key: `brief:${division}:2026-10-27`,
  brief_date: '2026-10-27',
  status: division === 'finance' ? 'watch' : 'normal',
  written_by: 'model',
  brief: BRIEFS[division],
  ceo_line: BRIEFS[division].ceoLine,
  created_at: '2026-10-27T12:01:00.000Z',
  ...over,
});
const state = (division: BriefDivision, over: Partial<RawDivisionState> = {}): RawDivisionState => ({
  division, brief: row(division), approval: null, decisions: [], unread: [], ...over,
});
const raw = (over: Partial<RawDivisions> = {}): RawDivisions => ({
  divisions: [state('salon'), state('finance'), state('online')], requests: [], replies: [], digest: null, unread: [], notes: [], ...over,
});
const decision = (rank: number, at = '2026-10-27T12:40:00.000Z', body: Record<string, unknown> = {}) => ({
  created_at: at,
  body: { type: 'action_decision', briefId: 'b-1', division: 'finance', rank, title: 'Some action', verdict: 'approved', by: 'demo-p-finance-owner', ...body },
});
const request = (id: string, from: string, to: string, question: string, at: string): RawRequest => ({
  id, from_assistant: from, to_assistant: to, created_at: at, body: { type: 'data_request', briefKey: 'brief:finance:2026-10-27', question },
});
const reply = (to: string, ok: unknown, at: string, reason: unknown = null): RawReply => ({ reply_to: to, created_at: at, ok, reason });

const view = (r: RawDivisions): DivisionsView => shapeDivisions(r, NOW);
const div = (v: DivisionsView, id: BriefDivision) => v.divisions.find((d) => d.id === id)!;
const everything = (v: unknown) => JSON.stringify(v);

// ---- The shaped view --------------------------------------------------------------------------------------

describe('the Divisions view: briefs', () => {
  it('lists the three divisions in the digest order, each with the head it writes to', () => {
    const v = view(raw());
    expect(v.divisions.map((d) => [d.id, d.name, d.head])).toEqual([
      ['salon', 'Salon', 'the head stylist'],
      ['finance', 'Finance', 'the finance owner'],
      ['online', 'Online', 'the online staff lead'],
    ]);
    expect(v.generatedAt).toBe(NOW.toISOString());
    expect(Object.keys(v).sort()).toEqual(['digest', 'divisions', 'generatedAt', 'notes', 'unread']);
    expect(Object.keys(v.divisions[0]!).sort()).toEqual(['asked', 'brief', 'head', 'id', 'manager', 'name', 'received', 'reports', 'unread']);
  });

  it('shows the latest brief: status, day, headline, findings with what they cite, actions, and the line to the CEO division', () => {
    const b = div(view(raw()), 'finance').brief!;
    expect(b).toMatchObject({
      date: '2026-10-27', createdAt: '2026-10-27T12:01:00.000Z', status: 'watch', writtenBy: 'model',
      headline: 'Google ads return 2.4x on $1,800 of spend.', ceoLine: 'Finance has something to watch; its head has the detail.',
    });
    expect(b.findings).toEqual([
      { text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] },
      { text: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] },
    ]);
    expect(b.actions.map((a) => [a.rank, a.title])).toEqual([[1, 'Hold Google spend'], [2, 'Check Mazali stock'], [3, 'Call the supplier']]);
    expect(Object.keys(b.actions[0]!).sort()).toEqual(['approval', 'cites', 'rank', 'steps', 'title', 'why']);
    expect(b.actions[0]).toMatchObject({ why: 'The return is 2.4x on $1,800 of spend.', steps: 'Keep the budget and review next week.', cites: ['m:online.ads.google.roas'] });
  });

  it('says a rule-written brief was written by rules', () => {
    const v = view(raw({ divisions: [state('salon'), state('finance', { brief: row('finance', { written_by: 'rule', status: 'act' }) }), state('online')] }));
    expect(div(v, 'finance').brief).toMatchObject({ writtenBy: 'rule', status: 'act' });
    expect(div(v, 'salon').brief).toMatchObject({ writtenBy: 'model', status: 'normal' });
  });

  it('keeps actions in rank order and shows a brief with no action as having none', () => {
    const shuffled = { ...financeBrief, actions: [financeBrief.actions[2]!, financeBrief.actions[0]!, financeBrief.actions[1]!] };
    const v = view(raw({ divisions: [state('salon'), state('finance', { brief: row('finance', { brief: shuffled }) }), state('online')] }));
    expect(div(v, 'finance').brief!.actions.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(div(v, 'salon').brief!.actions).toEqual([]);
  });

  it('is empty, not broken, before a division has written a brief', () => {
    const v = view(raw({ divisions: [state('salon', { brief: null }), state('finance', { brief: null }), state('online', { brief: null })] }));
    for (const d of v.divisions) expect(d).toMatchObject({ brief: null, asked: [], received: [], unread: [] });
    expect(v.digest).toBeNull();
    expect(v.notes).toEqual([]);
  });

  it('says a brief could not be read rather than showing it as missing, and shows a division the source forgot as unread', () => {
    const v = view(raw({
      divisions: [state('salon', { brief: null, unread: ['brief'] }), state('finance')],
      notes: ['The Salon brief could not be read right now (42P01).'],
    }));
    expect(div(v, 'salon')).toMatchObject({ brief: null, unread: ['brief'] });
    expect(div(v, 'online')).toMatchObject({ brief: null, unread: ['brief'] }); // not reported on at all
    expect(div(v, 'finance').unread).toEqual([]);
    expect(v.notes).toEqual(['The Salon brief could not be read right now (42P01).']);
  });
});

describe('the Divisions view: where each action stands', () => {
  const finance = (over: Partial<RawDivisionState>) => div(view(raw({ divisions: [state('salon'), state('finance', over), state('online')] })), 'finance').brief!.actions;
  const standing = (over: Partial<RawDivisionState>) => finance(over).map((a) => [a.approval.state, a.approval.at]);

  it('says no code was sent when none was', () => {
    expect(standing({ approval: null })).toEqual([['no_code', null], ['no_code', null], ['no_code', null]]);
  });

  it('says a code is waiting, with when it ends, until the clock passes it', () => {
    const waiting = standing({ approval: { status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null } });
    expect(waiting).toEqual(Array(3).fill(['awaiting', '2026-10-28T00:00:00.000Z']));
    // The database only marks a code expired when someone tries it, so an old waiting code is shown as expired.
    const lapsed = standing({ approval: { status: 'pending', expires_at: '2026-10-27T13:00:00Z', decided_at: null } });
    expect(lapsed).toEqual(Array(3).fill(['code_expired', '2026-10-27T13:00:00.000Z']));
  });

  it('says a code expired or was locked', () => {
    expect(standing({ approval: { status: 'expired', expires_at: '2026-10-27T13:00:00Z', decided_at: null } })[0]).toEqual(['code_expired', '2026-10-27T13:00:00.000Z']);
    expect(standing({ approval: { status: 'locked', expires_at: '2026-10-28T00:00:00Z', decided_at: null } })[0]).toEqual(['code_locked', null]);
  });

  it('marks the actions the head approved, and the others as not approved once the code was used', () => {
    const used = { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' };
    expect(standing({ approval: used, decisions: [decision(1), decision(3, '2026-10-27T12:41:00Z')] })).toEqual([
      ['approved', '2026-10-27T12:40:00.000Z'],
      ['not_approved', '2026-10-27T12:40:00.000Z'],
      ['approved', '2026-10-27T12:41:00.000Z'],
    ]);
  });

  it('keeps an approval an approval whatever became of the code, and counts only an approved verdict', () => {
    const states = finance({
      approval: { status: 'expired', expires_at: '2026-10-27T13:00:00Z', decided_at: null },
      decisions: [decision(2), decision(1, '2026-10-27T12:50:00Z', { verdict: 'declined' }), decision(9), decision(0)],
    }).map((a) => a.approval.state);
    expect(states).toEqual(['code_expired', 'approved', 'code_expired']);
  });

  it('says it cannot tell when the approvals could not be read, but still shows what it did read as approved', () => {
    const states = finance({ unread: ['actions'], decisions: [decision(2)] }).map((a) => a.approval.state);
    expect(states).toEqual(['unknown', 'approved', 'unknown']);
    expect(standing({ unread: ['actions'] })).toEqual(Array(3).fill(['unknown', null]));
  });

  it('shows a code status this console does not know as unknown', () => {
    expect(standing({ approval: { status: 'weird', expires_at: '2026-10-28T00:00:00Z', decided_at: null } })[0]).toEqual(['unknown', null]);
  });

  it('never reads who approved: a person id, the code hash or a row id never leaves', () => {
    const v = view(raw({
      divisions: [state('salon'), state('finance', {
        approval: { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z', code_hash: 'a'.repeat(64), message_id: 'doc-1' } as never,
        decisions: [decision(1, '2026-10-27T12:40:00Z', { by: 'demo-p-finance-owner', briefId: 'brief-row-1' })],
      }), state('online')],
    }));
    expect(everything(v)).not.toMatch(/demo-p-|a{40}|code_hash|doc-1|brief-row-1/);
  });
});

describe('the Divisions view: data requests', () => {
  const requests = [
    request('r1', 'finance', 'online', 'What did Mazali bring in online?', '2026-10-27T12:00:30Z'),
    request('r2', 'finance', 'salon', 'How many appointments did the salon book?', '2026-10-27T12:00:40Z'),
    request('r3', 'online', 'finance', 'What is the ad return?', '2026-10-27T12:01:10Z'),
    request('r4', 'salon', 'finance', 'What was last month spend?', '2026-10-26T12:01:10Z'),
  ];
  const replies = [
    reply('r1', 'true', '2026-10-27T12:00:50Z'),
    reply('r2', 'false', '2026-10-27T12:00:55Z', "Code Mode isn't connected on this machine"),
    reply('r4', true, '2026-10-26T12:02:00Z'),
  ];

  it('pairs each question with its answer and files it under the division that asked and the one that was asked, newest first', () => {
    const v = view(raw({ requests, replies }));
    expect(div(v, 'finance').asked.map((q) => [q.to, q.state, q.answeredAt])).toEqual([
      ['salon', 'unavailable', '2026-10-27T12:00:55.000Z'],
      ['online', 'answered', '2026-10-27T12:00:50.000Z'],
    ]);
    expect(div(v, 'finance').received.map((q) => [q.from, q.state, q.answeredAt])).toEqual([
      ['online', 'unanswered', null],
      ['salon', 'answered', '2026-10-26T12:02:00.000Z'],
    ]);
    expect(div(v, 'online').received.map((q) => q.question)).toEqual(['What did Mazali bring in online?']);
    expect(div(v, 'online').asked.map((q) => q.question)).toEqual(['What is the ad return?']);
    expect(div(v, 'salon').received.map((q) => q.from)).toEqual(['finance']);
    expect(div(v, 'salon').asked.map((q) => q.to)).toEqual(['finance']);
  });

  it('keeps the plain reason an unavailable answer gave, and nothing of what an answer carried', () => {
    const v = view(raw({ requests, replies: [{ ...reply('r2', false, '2026-10-27T12:00:55Z', 'the lookup failed'), facts: { metrics: { x: 1 } } } as never] }));
    const q = div(v, 'finance').asked.find((x) => x.to === 'salon')!;
    expect(q).toEqual({
      from: 'finance', to: 'salon', question: 'How many appointments did the salon book?', askedAt: '2026-10-27T12:00:40.000Z',
      answeredAt: '2026-10-27T12:00:55.000Z', state: 'unavailable', reason: 'the lookup failed',
    });
    expect(everything(v)).not.toContain('metrics');
  });

  it('reads the outcome whether the database sends it as a flag or as text', () => {
    const v = view(raw({ requests, replies: [reply('r1', true, '2026-10-27T12:00:50Z'), reply('r2', 'false', '2026-10-27T12:00:55Z', 'no')] }));
    expect(div(v, 'finance').asked.map((q) => q.state)).toEqual(['unavailable', 'answered']);
  });

  it('shows a question nobody answered yet as waiting for an answer', () => {
    const v = view(raw({ requests: [requests[2]!], replies: [] }));
    expect(div(v, 'online').asked).toEqual([expect.objectContaining({ to: 'finance', state: 'unanswered', answeredAt: null, reason: null })]);
  });

  it('leaves out a request between unknown parties, one that is not a data request and one without a question, and says so', () => {
    const v = view(raw({
      requests: [
        request('x1', 'finance', 'owner', 'A question to HQ', '2026-10-27T12:00:00Z'),
        { ...request('x2', 'finance', 'online', 'x', '2026-10-27T12:00:00Z'), body: { type: 'something_else', question: 'Not a data request' } },
        request('x3', 'finance', 'online', '   ', '2026-10-27T12:00:00Z'),
        { ...request('x4', 'finance', 'online', 'x', '2026-10-27T12:00:00Z'), body: 'not an object' },
        request('ok', 'finance', 'online', 'A fine question', '2026-10-27T12:00:00Z'),
      ],
    }));
    expect(div(v, 'finance').asked.map((q) => q.question)).toEqual(['A fine question']);
    expect(v.notes).toEqual(['Some data requests could not be read and are left out.']);
  });

  it('shows an answer it cannot read as unreadable, with a note, and keeps the rest', () => {
    const v = view(raw({ requests, replies: [reply('r1', 'maybe', '2026-10-27T12:00:50Z'), reply('r2', true, '2026-10-27T12:00:55Z')] }));
    expect(div(v, 'finance').asked.map((q) => [q.to, q.state, q.answeredAt])).toEqual([['salon', 'answered', '2026-10-27T12:00:55.000Z'], ['online', 'unreadable', null]]);
    expect(v.notes).toContain('Some answers to data requests could not be read. Those requests are shown as unreadable.');
  });

  it('shows every question as unreadable, not unanswered, when no answer could be read at all', () => {
    const v = view(raw({ requests, replies: [], unread: ['replies'], notes: ['The answers to the data requests could not be read right now (42P01).'] }));
    expect([...div(v, 'finance').asked, ...div(v, 'finance').received].map((q) => q.state)).toEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable']);
    expect(v.unread).toEqual(['replies']);
  });

  it('shows at most ten questions each way for a division', () => {
    const many = Array.from({ length: 25 }, (_, i) => request(`m${i}`, 'finance', 'online', `Question ${i}`, `2026-10-27T10:${String(i).padStart(2, '0')}:00Z`));
    const v = view(raw({ requests: many }));
    expect(div(v, 'finance').asked).toHaveLength(10);
    expect(div(v, 'finance').asked[0]!.question).toBe('Question 24'); // newest first
    expect(div(v, 'online').received).toHaveLength(10);
  });
});

describe('the Divisions view: the CEO digest', () => {
  const digestRow = (body: unknown) => ({ created_at: '2026-10-27T12:30:05.000Z', body });
  const goodBody = {
    type: 'ceo_digest', date: '2026-10-27',
    text: 'Company status for 2026-10-27:\nSalon: running normally.\nFinance: needs a look — Finance has something to watch; its head has the detail.\nOnline: no report yet.',
    reports: [
      { division: 'salon', state: 'in', status: 'normal', ceoLine: 'Salon is running normally.' },
      { division: 'finance', state: 'in', status: 'watch', ceoLine: 'Finance has something to watch; its head has the detail.' },
      { division: 'online', state: 'missing' },
    ],
  };

  it('shows the words the owner was sent, the day, and what each division had reported', () => {
    const d = view(raw({ digest: digestRow(goodBody) })).digest!;
    expect(d).toEqual({
      date: '2026-10-27', createdAt: '2026-10-27T12:30:05.000Z', text: goodBody.text,
      reports: [
        { division: 'salon', state: 'in', status: 'normal' },
        { division: 'finance', state: 'in', status: 'watch' },
        { division: 'online', state: 'missing', status: null },
      ],
    });
  });

  it('is null, with no note, before any digest exists', () => {
    const v = view(raw({ digest: null }));
    expect(v.digest).toBeNull();
    expect(v.notes).toEqual([]);
  });

  it('leaves out a digest it cannot read and says so; a bad report line is dropped, not the whole digest', () => {
    for (const body of ['nonsense', { type: 'something_else', text: 'x' }, { type: 'ceo_digest', text: '' }, null]) {
      const v = view(raw({ digest: digestRow(body) }));
      expect(v.digest, JSON.stringify(body)).toBeNull();
      expect(v.notes).toEqual(['The latest digest could not be read in full (unexpected shape). What could not be read is left out.']);
    }
    const partial = view(raw({ digest: digestRow({ ...goodBody, reports: [...goodBody.reports, { division: 'owner', state: 'in' }, 'junk'] }) }));
    expect(partial.digest!.reports).toHaveLength(3);
    expect(partial.notes).toHaveLength(1);
    const noReports = view(raw({ digest: digestRow({ ...goodBody, reports: 'x', date: 'soon' }) }));
    expect(noReports.digest).toMatchObject({ reports: [], date: null, text: goodBody.text });
  });

  it('carries the parts that could not be read', () => {
    const v = view(raw({ unread: ['digest', 'requests'], notes: ['The latest CEO digest could not be read right now (57014).'] }));
    expect(v.unread).toEqual(['digest', 'requests']);
    expect(v.digest).toBeNull();
    expect(v.notes).toEqual(['The latest CEO digest could not be read right now (57014).']);
  });
});

describe('the Divisions view: scrubbing and bad data', () => {
  const DIRTY = 'code 482915 to +15559876543 (key sb_secret_abc123 service_role eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig)';

  it('lets no code, phone number, key or hash out, in any text of the view', () => {
    const dirtyBrief = {
      headline: `Headline ${DIRTY}`,
      findings: [{ text: `Finding ${DIRTY}`, cites: [`m:cite.${DIRTY}`] }],
      actions: [{ rank: 1, title: `Title ${DIRTY}`, why: `Why ${DIRTY}`, steps: `Steps ${DIRTY}`, cites: [] }],
      ceoLine: 'x',
    };
    const v = view(raw({
      divisions: [state('salon'), state('finance', { brief: row('finance', { brief: dirtyBrief, ceo_line: `CEO ${DIRTY}` }) }), state('online')],
      requests: [request('r1', 'finance', 'online', `Question ${DIRTY}`, '2026-10-27T12:00:00Z')],
      replies: [reply('r1', false, '2026-10-27T12:01:00Z', `Reason ${DIRTY}`)],
      digest: { created_at: '2026-10-27T12:30:00Z', body: { type: 'ceo_digest', date: '2026-10-27', text: `Digest ${DIRTY}`, reports: [] } },
      notes: [`Note ${DIRTY}`],
    }));
    const text = everything(v);
    expect(text).not.toMatch(/\d{6}/);
    expect(text).not.toMatch(PHONE_LIKE);
    for (const bad of SECRET_LOOKING) expect(text).not.toMatch(bad);
    expect(text).toContain('…6543');
    expect(text).toContain('[hidden]');
  });

  it('cuts every text and list to its limit, after cleaning', () => {
    const long = 'word '.repeat(300);
    const huge = {
      headline: long,
      findings: Array.from({ length: 9 }, (_, i) => ({ text: `${long}${i}`, cites: Array.from({ length: 20 }, (__, c) => `m:cite.${c}`) })),
      actions: Array.from({ length: 9 }, (_, i) => ({ rank: (i % 3) + 1, title: long, why: long, steps: long, cites: [] })),
      ceoLine: long,
    };
    const v = view(raw({
      divisions: [state('salon'), state('finance', { brief: row('finance', { brief: huge, ceo_line: long }) }), state('online')],
      requests: [request('r1', 'finance', 'online', long, '2026-10-27T12:00:00Z')],
      replies: [reply('r1', false, '2026-10-27T12:01:00Z', long)],
      digest: { created_at: '2026-10-27T12:30:00Z', body: { type: 'ceo_digest', date: '2026-10-27', text: long.repeat(5), reports: [] } },
    }));
    const b = div(v, 'finance').brief!;
    expect(b.headline.length).toBeLessThanOrEqual(160);
    expect(b.findings).toHaveLength(4);
    for (const f of b.findings) {
      expect(f.text.length).toBeLessThanOrEqual(300);
      expect(f.cites).toHaveLength(8);
    }
    expect(b.actions).toHaveLength(3);
    for (const a of b.actions) {
      expect(a.title.length).toBeLessThanOrEqual(80);
      expect(a.why.length).toBeLessThanOrEqual(300);
      expect(a.steps.length).toBeLessThanOrEqual(300);
    }
    expect(b.ceoLine.length).toBeLessThanOrEqual(140);
    const q = div(v, 'finance').asked[0]!;
    expect(q.question.length).toBeLessThanOrEqual(300);
    expect(q.reason!.length).toBeLessThanOrEqual(200);
    expect(v.digest!.text.length).toBeLessThanOrEqual(600);
  });

  it('turns a brief of the wrong shape into a note and keeps what is readable', () => {
    const v = view(raw({
      divisions: [
        state('salon', { brief: row('salon', { brief: 42 }) }),
        state('finance', {
          brief: row('finance', {
            status: 'weird', written_by: 'a person', brief_date: 'garbage',
            brief: { headline: 'Still readable', findings: 'not a list', actions: [{ rank: 9, title: 'Bad rank' }, { rank: 1, title: '' }, 'junk', { rank: 2, title: 'Good', why: 'w', steps: 's', cites: 'x' }] },
          }),
        }),
        state('online', { brief: row('online', { brief: JSON.stringify(onlineBrief) }) }),
      ],
    }));
    expect(div(v, 'salon').brief).toMatchObject({ headline: '', findings: [], actions: [] });
    const finance = div(v, 'finance').brief!;
    expect(finance).toMatchObject({ status: 'unknown', writtenBy: 'unknown', date: null, headline: 'Still readable', findings: [] });
    expect(finance.actions.map((a) => [a.rank, a.title, a.cites])).toEqual([[2, 'Good', []]]);
    expect(div(v, 'online').brief!.headline).toBe('Mazali brought in $12,400 online.'); // JSON text is read too
    expect(v.notes).toEqual([
      'A brief could not be read in full (unexpected shape). What could not be read is left out.',
      'A brief has a status this console does not know. It is shown as unknown.',
    ]);
  });

  it('survives a source that sends lists of the wrong kind', () => {
    const odd = { divisions: 'x', requests: null, replies: {}, digest: 7, unread: 'x', notes: 'x' } as never;
    const v = view(odd);
    expect(v.divisions).toHaveLength(3);
    for (const d of v.divisions) expect(d).toMatchObject({ brief: null, asked: [], received: [], unread: ['brief'] });
    expect(v.digest).toBeNull();
  });
});

// ---- The loader, against a recording fake of the Supabase client --------------------------------------------

describe('the Divisions loader', () => {
  const BRIEF_COLUMNS = 'division,brief_key,brief_date,status,written_by,brief,ceo_line,created_at';
  const NOT_SAFE = /\*|code_hash|decided_by|payload|phone|idempotency|lease|task_id|data_source/;
  const id = (call: Call, op: string) => call.ops.find((x) => x.startsWith(`${op}(`));
  const docKey = (d: string) => `briefdoc:brief:${d}:2026-10-27`;
  const docs = [
    { id: 'doc-salon', dedupe_key: docKey('salon') },
    { id: 'doc-finance', dedupe_key: docKey('finance') },
    { id: 'doc-online', dedupe_key: docKey('online') },
  ];
  const digestRow = { created_at: '2026-10-27T12:30:05Z', body: { type: 'ceo_digest', date: '2026-10-27', text: 'Company status', reports: [] } };

  function happy(call: Call) {
    if (call.table === 'division_briefs') {
      const division = id(call, 'eq')!.slice('eq(division,'.length, -1) as BriefDivision;
      return { data: [row(division)] };
    }
    if (call.table === 'approvals') {
      return {
        data: [
          { message_id: 'doc-finance', status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' },
          { message_id: 'doc-finance', status: 'expired', expires_at: '2026-10-27T10:00:00Z', decided_at: null }, // older: must not win
          { message_id: 'doc-online', status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null },
        ],
      };
    }
    if (call.table === 'assistant_messages') {
      if (call.select === 'id,dedupe_key') return { data: docs };
      if (call.ops.includes('eq(kind,decision)')) {
        return { data: [{ reply_to: 'doc-finance', ...decision(2) }, { reply_to: 'doc-online', ...decision(1, '2026-10-27T12:45:00Z', { division: 'online' }) }] };
      }
      if (call.ops.includes('like(dedupe_key,datareq:%)')) {
        return { data: [request('r1', 'finance', 'online', 'What did Mazali bring in online?', '2026-10-27T12:00:30Z')] };
      }
      if (call.ops.includes('like(dedupe_key,datareply:%)')) return { data: [reply('r1', 'true', '2026-10-27T12:00:50Z')] };
      if (call.ops.includes('like(dedupe_key,digestdoc:%)')) return { data: [digestRow] };
    }
    return { data: [] };
  }

  it('reads only named columns, newest first, small limits, and only the kinds of note it shows', async () => {
    const r = recorder(happy);
    await createDivisionsLoader({ db: r.db })();

    const briefs = r.calls.filter((c) => c.table === 'division_briefs');
    expect(briefs.map((c) => id(c, 'eq'))).toEqual(['eq(division,salon)', 'eq(division,finance)', 'eq(division,online)']);
    for (const c of briefs) {
      expect(c.select).toBe(BRIEF_COLUMNS);
      expect(c.ops.filter((op) => op.startsWith('order('))).toEqual(['order(brief_date,{"ascending":false})', 'order(created_at,{"ascending":false})']);
      expect(c.ops).toContain('limit(1)');
    }

    const mailbox = r.calls.filter((c) => c.table === 'assistant_messages');
    const notes = mailbox.find((c) => c.select === 'id,dedupe_key')!;
    expect(notes.ops).toContain(`in(dedupe_key,${JSON.stringify([docKey('salon'), docKey('finance'), docKey('online')])})`);
    const decisions = mailbox.find((c) => c.ops.includes('eq(kind,decision)'))!;
    expect(decisions.select).toBe('reply_to,created_at,body');
    expect(decisions.ops).toContain('like(dedupe_key,action-decision:%)');
    expect(decisions.ops).toContain('in(reply_to,["doc-salon","doc-finance","doc-online"])');
    const asked = mailbox.find((c) => c.ops.includes('like(dedupe_key,datareq:%)'))!;
    expect(asked.select).toBe('id,from_assistant,to_assistant,created_at,body');
    expect(asked.ops).toContain('eq(kind,request)');
    expect(asked.ops).toContain('limit(30)');
    // The answers are read as an outcome and a reason only: what they carried (their facts) is never selected.
    const answers = mailbox.find((c) => c.ops.includes('like(dedupe_key,datareply:%)'))!;
    expect(answers.select).toBe('reply_to,created_at,ok:body->>ok,reason:body->>reason');
    expect(answers.ops).toContain('eq(kind,report)');
    expect(answers.ops).toContain('in(reply_to,["r1"])');
    expect(answers.ops).toContain('limit(100)');
    const digest = mailbox.find((c) => c.ops.includes('like(dedupe_key,digestdoc:%)'))!;
    expect(digest.select).toBe('created_at,body');
    expect(digest.ops).toEqual(expect.arrayContaining(['eq(kind,report)', 'eq(from_assistant,owner)', 'eq(to_assistant,owner)', 'limit(1)']));
    expect(digest.ops.some((op) => op.startsWith('order(created_at'))).toBe(true);

    const approvals = r.calls.filter((c) => c.table === 'approvals');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.select).toBe('message_id,status,expires_at,decided_at');
    expect(approvals[0]!.ops).toContain('eq(action,approve_action)');
    expect(approvals[0]!.ops).toContain('in(message_id,["doc-salon","doc-finance","doc-online"])');

    // Nothing else is touched: not people, inbound texts, the outbox or the spending table. (The two report tables are wave 2's:
    // reports-loader.test.ts holds what is read from them.)
    expect([...new Set(r.calls.map((c) => c.table))].sort()).toEqual(['approvals', 'assistant_messages', 'division_briefs', 'weekly_reports', 'worker_reports']);
    for (const c of r.calls) {
      expect(c.select, c.table).not.toMatch(NOT_SAFE);
      expect(Number(id(c, 'limit')?.slice(6, -1)), `${c.table} limit`).toBeLessThanOrEqual(100);
    }
  });

  it('puts each approval and decision with its own brief, the newest code first', async () => {
    const r = recorder(happy);
    const loaded = await createDivisionsLoader({ db: r.db })();
    const by = Object.fromEntries(loaded.divisions.map((d) => [d.division, d]));
    expect(by.salon).toMatchObject({ approval: null, decisions: [], unread: [] });
    expect(by.finance!.approval).toEqual({ message_id: 'doc-finance', status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' });
    expect(by.finance!.decisions).toHaveLength(1);
    expect(by.online!.approval).toMatchObject({ status: 'pending' });
    expect(by.online!.decisions).toHaveLength(1);
    expect(loaded.requests).toHaveLength(1);
    expect(loaded.replies).toHaveLength(1);
    expect(loaded.digest).toEqual(digestRow);
    expect(loaded.unread).toEqual([]);
    expect(loaded.notes).toEqual([]);

    const shaped = shapeDivisions(loaded, NOW);
    expect(div(shaped, 'finance').brief!.actions.map((a) => a.approval.state)).toEqual(['not_approved', 'approved', 'not_approved']);
    expect(div(shaped, 'online').brief!.actions.map((a) => a.approval.state)).toEqual(['approved']);
    expect(div(shaped, 'finance').asked[0]).toMatchObject({ to: 'online', state: 'answered' });
  });

  it('asks nothing about approvals or answers when there is nothing to ask about', async () => {
    const r = recorder((call) => (call.table === 'division_briefs' ? { data: [] } : { data: [] }));
    const loaded = await createDivisionsLoader({ db: r.db })();
    expect(loaded.divisions.map((d) => [d.division, d.brief, d.unread])).toEqual([['salon', null, []], ['finance', null, []], ['online', null, []]]);
    expect(loaded).toMatchObject({ requests: [], replies: [], digest: null, unread: [], notes: [] });
    expect([...new Set(r.calls.map((c) => c.table))].sort()).toEqual(['assistant_messages', 'division_briefs', 'weekly_reports', 'worker_reports']);
    expect(r.calls.some((c) => c.select === 'id,dedupe_key')).toBe(false);
    expect(r.calls.some((c) => c.ops.includes('like(dedupe_key,datareply:%)'))).toBe(false);
  });

  it('names the part it could not read by name and code, shows it as unread rather than empty, and keeps the rest', async () => {
    const fail = (match: (c: Call) => boolean, code: string) =>
      recorder((call) => (match(call) ? { data: null, error: { message: 'relation boom does not exist', code } } : happy(call)));
    const load = async (r: ReturnType<typeof recorder>) => createDivisionsLoader({ db: r.db })();

    // One division's brief
    let loaded = await load(fail((c) => c.table === 'division_briefs' && c.ops.includes('eq(division,finance)'), '42P01'));
    expect(loaded.divisions.map((d) => [d.division, d.brief === null, d.unread])).toEqual([['salon', false, []], ['finance', true, ['brief']], ['online', false, []]]);
    expect(loaded.notes).toEqual(['The Finance brief could not be read right now (42P01).']);

    // Where the actions stand: the notes the codes hang from, the codes, or the decisions
    for (const [label, match] of [
      ['The briefs\' mailbox notes', (c: Call) => c.select === 'id,dedupe_key'],
      ['The brief approvals', (c: Call) => c.table === 'approvals'],
      ['The approved actions', (c: Call) => c.ops.includes('eq(kind,decision)')],
    ] as const) {
      loaded = await load(fail(match, '57014'));
      expect(loaded.divisions.map((d) => d.unread), label).toEqual([['actions'], ['actions'], ['actions']]);
      expect(loaded.notes).toEqual([`${label} could not be read right now (57014).`]);
      expect(loaded.divisions.every((d) => d.brief !== null)).toBe(true);
      expect(loaded.requests).toHaveLength(1);
      expect(loaded.digest).not.toBeNull();
    }

    // The requests: nothing to match answers to, so the answers are not read either
    let r = fail((c) => c.ops.includes('like(dedupe_key,datareq:%)'), '57014');
    loaded = await load(r);
    expect(loaded).toMatchObject({ requests: [], replies: [], unread: ['requests'] });
    expect(r.calls.some((c) => c.ops.includes('like(dedupe_key,datareply:%)'))).toBe(false);

    // The answers: the questions still show
    loaded = await load(fail((c) => c.ops.includes('like(dedupe_key,datareply:%)'), '22023'));
    expect(loaded.requests).toHaveLength(1);
    expect(loaded.unread).toEqual(['replies']);
    expect(loaded.notes).toEqual(['The answers to the data requests could not be read right now (22023).']);
    expect(div(shapeDivisions(loaded, NOW), 'finance').asked[0]!.state).toBe('unreadable');

    // The digest
    r = fail((c) => c.ops.includes('like(dedupe_key,digestdoc:%)'), '57014');
    loaded = await load(r);
    expect(loaded).toMatchObject({ digest: null, unread: ['digest'] });
    expect(loaded.notes).toEqual(['The latest CEO digest could not be read right now (57014).']);

    for (const note of loaded.notes) expect(note).not.toMatch(/boom|relation/);
  });

  it('reads nothing when the database is down, and says so for every part', async () => {
    const r = recorder(() => ({ data: null, error: { message: 'connection refused', code: '08006' } }));
    const loaded = await createDivisionsLoader({ db: r.db })();
    expect(loaded.divisions.map((d) => d.unread)).toEqual([['brief'], ['brief'], ['brief']]);
    expect(loaded.unread).toEqual(['requests', 'digest']);
    const v = shapeDivisions(loaded, NOW);
    expect(v.divisions.every((d) => d.brief === null)).toBe(true);
    expect(v.notes.length).toBeGreaterThan(0);
    expect(everything(v.notes)).not.toContain('connection refused');
  });
});

// ---- The server ---------------------------------------------------------------------------------------

describe('GET /api/divisions', () => {
  const running: RunningConsole[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.close();
  });
  async function start(loadDivisions: () => Promise<RawDivisions>, log: (line: string) => void = () => {}) {
    const c = await startConsoleServer({ load: async () => { throw new Error('not used'); }, loadDivisions, now: () => NOW, log }, 0);
    running.push(c);
    return c;
  }

  it('serves the shaped view, read once per request, and nothing secret', async () => {
    const dirty = raw({
      divisions: [state('salon'), state('finance', { approval: { status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null, code_hash: 'a'.repeat(64) } as never, decisions: [decision(1)] }), state('online')],
      requests: [request('r1', 'finance', 'online', 'What did Mazali bring in? Call +15559876543, code 482915', '2026-10-27T12:00:30Z')],
      replies: [reply('r1', 'true', '2026-10-27T12:00:50Z')],
    });
    const loadDivisions = vi.fn(async () => dirty);
    const c = await start(loadDivisions);
    const res = await fetch(`${c.url}/api/divisions`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(shapeDivisions(dirty, NOW))));
    expect(loadDivisions).toHaveBeenCalledTimes(1);
    expect(text).not.toMatch(/\d{6}/);
    expect(text).not.toMatch(PHONE_LIKE);
    for (const bad of SECRET_LOOKING) expect(text).not.toMatch(bad);
    expect(text).not.toMatch(/demo-p-|a{40}/);
  });

  it('answers 502 in plain words, without the cause, and logs only a code', async () => {
    const log = vi.fn();
    const c = await start(async () => { throw new Error('connect ECONNREFUSED with key sb_secret_xyz and code 482915'); }, log);
    const res = await fetch(`${c.url}/api/divisions`);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('The divisions could not be read right now. Try again in a moment.');
    expect(text).not.toMatch(/sb_secret|ECONNREFUSED|\d{6}/);
    expect(log).toHaveBeenCalledWith('console.load_failed department=divisions reason=error');
    for (const line of log.mock.calls.flat()) expect(String(line)).not.toMatch(/sb_secret|\d{6}/);
  });

  it('is read only and local only like the rest of the console', async () => {
    const loadDivisions = vi.fn(async () => raw());
    const c = await start(loadDivisions);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${c.url}/api/divisions`, { method });
      expect(res.status, method).toBe(405);
    }
    expect((await fetch(`${c.url}/api/divisions/`)).status).toBe(404);
    expect(loadDivisions).not.toHaveBeenCalled();
  });
});

// ---- The page, drawn for real against a tiny fake of the browser ---------------------------------------------

describe('the page draws the Divisions view', () => {
  const NOT_BROKEN = /undefined|NaN|\[object|null/;
  const digestBody = {
    type: 'ceo_digest', date: '2026-10-27',
    text: 'Company status for 2026-10-27:\nSalon: running normally.\nFinance: needs a look — Finance has something to watch; its head has the detail.\nOnline: no report yet.',
    reports: [
      { division: 'salon', state: 'in', status: 'normal', ceoLine: 'Salon is running normally.' },
      { division: 'finance', state: 'in', status: 'watch', ceoLine: 'Finance has something to watch; its head has the detail.' },
      { division: 'online', state: 'missing' },
    ],
  };

  it('draws the digest, each division\'s brief with where its actions stand, and the questions asked and received', async () => {
    const shown = await drawTab('divisions', view(raw({
      divisions: [
        state('salon'),
        state('finance', {
          approval: { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' },
          decisions: [decision(1)],
          brief: row('finance', { written_by: 'rule' }),
        }),
        state('online', { approval: { status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null } }),
      ],
      requests: [
        request('r1', 'finance', 'online', 'What did Mazali bring in online?', '2026-10-27T12:00:30Z'),
        request('r2', 'finance', 'salon', 'How many appointments did the salon book?', '2026-10-27T12:00:40Z'),
        request('r3', 'online', 'finance', 'What is the ad return?', '2026-10-27T12:01:10Z'),
      ],
      replies: [reply('r1', 'true', '2026-10-27T12:00:50Z'), reply('r2', 'false', '2026-10-27T12:00:55Z', 'the lookup failed')],
      digest: { created_at: '2026-10-27T12:30:05Z', body: digestBody },
    })));
    for (const part of [
      // the digest
      'CEO digest', 'Company status for 2026-10-27', 'Salon: running normally.', 'Finance: needs a look', 'Online: no report yet.',
      // the divisions
      'Salon division', 'Finance division', 'Online division', 'Its assistant writes to the finance owner.',
      'Brief for 2026-10-27', 'needs a look', 'running normally', 'written by rules',
      'Google ads return 2.4x on $1,800 of spend.', 'Based on m:online.ads.google.roas, m:online.ads.google.spend',
      // the actions
      '1. Hold Google spend', 'Why: The return is 2.4x on $1,800 of spend.', 'Steps: Keep the budget and review next week.',
      'approved', 'not approved', 'The code was used for other actions', 'waiting for a code', 'A code is waiting. It expires',
      'This brief proposes no action, so there is nothing for the head to approve.',
      'Line to the CEO division: Finance has something to watch; its head has the detail.',
      // the questions
      'Questions it asked', 'Questions it was asked', 'Finance asked Online', 'What did Mazali bring in online?', 'Answered',
      'could not answer', 'the lookup failed', 'waiting for an answer', 'Online asked Finance',
    ]) expect(shown, part).toContain(part);
    expect(shown).not.toMatch(NOT_BROKEN);
    expect(shown).not.toMatch(/\d{6}/);
  });

  it('draws "no brief yet" and "none" for empty parts, and "could not be read" for unread ones', async () => {
    const empty = await drawTab('divisions', view(raw({ divisions: [state('salon', { brief: null }), state('finance', { brief: null }), state('online', { brief: null })] })));
    expect(empty).toContain('No brief yet. It is written each morning, or when the owner or the head texts BRIEF.');
    expect(empty).toContain('None. It has asked nothing of the other divisions.');
    expect(empty).toContain('None. No other division has asked it anything.');
    expect(empty).toContain('No digest yet. Owner HQ writes one each morning once the divisions have reported.');
    expect(empty).not.toMatch(NOT_BROKEN);

    const unread = await drawTab('divisions', view(raw({
      divisions: [state('salon', { brief: null, unread: ['brief'] }), state('finance', { unread: ['actions'] }), state('online', { brief: null })],
      requests: [], unread: ['requests', 'digest'],
      notes: ['The Salon brief could not be read right now (42P01).'],
    })));
    expect(unread).toContain('The latest brief could not be read right now. See the notes above.');
    expect(unread).toContain('The data requests could not be read right now. See the notes above.');
    expect(unread).toContain('The latest digest could not be read right now. See the notes above.');
    expect(unread).toContain('Where this action stands could not be read right now');
    expect(unread).toContain('The Salon brief could not be read right now (42P01).');
    expect(unread).not.toContain('No digest yet.');
    expect(unread).not.toMatch(NOT_BROKEN);
  });

  it('draws what a head would read as a decision: the action, its reason and its steps are all text, never markup', async () => {
    const markup = { ...financeBrief, headline: '<img src=x onerror=alert(1)> headline', actions: [{ rank: 1, title: '<b>Bold</b>', why: '<script>alert(1)</script>', steps: 'a & b', cites: [] }] };
    const shown = await drawTab('divisions', view(raw({ divisions: [state('salon'), state('finance', { brief: row('finance', { brief: markup }) }), state('online')] })));
    expect(shown).toContain('<img src=x onerror=alert(1)> headline'); // shown as the characters it is, set with textContent
    expect(shown).toContain('1. <b>Bold</b>');
  });

  it('draws the salon as a live tab with its own data and a note that Cindy\'s own app keeps her personal data', async () => {
    const salon: RawDepartment = {
      assistant: { display_name: 'Salon stand-in', sms_from: '+15551230001' },
      counts: { openTasks: 1, proposals: 0, pendingApprovals: 0 },
      tasks: [{ id: '3f2a91bc-1111-4222-8333-444455556666', kind: 'scheduled', status: 'done', attempts: 1, last_error: null, created_at: '2026-10-27T12:00:00Z' }],
      messages: [], approvals: [], outbox: [], receipts: [],
      reports: [], decisions: [], timeline: [], notes: [],
    };
    const info = DEPARTMENTS.find((d) => d.id === 'salon')!;
    const shown = await drawTab('salon', shapeDepartment(salon, info, NOW));
    expect(shown).toContain('Salon stand-in');
    expect(shown).toContain('texts from …0001');
    expect(shown).toContain('stand-in for Cindy');
    expect(shown).toContain('Cindy’s own app keeps her family and personal data; none of it is read here.');
    expect(shown).toContain('A scheduled job');
    expect(shown).not.toContain('Cindy runs in her own app');
    expect(shown).not.toMatch(/undefined|NaN|\[object/);
    // The other tabs carry no such note.
    const other = await drawTab('finance', shapeDepartment(salon, DEPARTMENTS.find((d) => d.id === 'finance')!, NOW));
    expect(other).not.toContain('Cindy');
  });
});
