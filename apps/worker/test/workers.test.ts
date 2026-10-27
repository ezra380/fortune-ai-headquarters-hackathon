import { describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, WORKER_IDS, workerDivision, type Metric, type MetricInfo, type Receipt } from '@fahq/contracts';
import { CATALOG_V2 } from '@fahq/data';
import { loadProfiles } from '@fahq/profiles';
import type { WorkerDeps } from '../src/common.ts';
import { createReadTools } from '../src/read-tools.ts';
import { SCHEDULE, dueJobs, runDueJobs } from '../src/scheduler.ts';
import {
  PENDING_DATA_PREFIXES, PENDING_ROW_TOOLS, WORKERS, checkWorkerWords, ruleWords, totalsAt, workerBusiness, workerKey, workerSlice, workerSource, type WorkerDef,
} from '../src/workers.ts';

// The parts of the daily workers that need no database: the registry against the v2 catalog and the profiles, what a
// worker keeps of its division's read, the check on its words, the rule-written words and the 07:00 clock.

const catalog: MetricInfo[] = CATALOG_V2.map((m) => ({ id: m.id, label: m.label, unit: m.unit, business: m.business, divisions: m.divisions }));
const readBy = (division: string) => catalog.filter((m) => m.divisions?.includes(division as never));
const source = { system: 'zetaris' as const, view: 'fortune_demo_finance_mart', queryHash: 'c'.repeat(64), asOf: '2026-10-26T12:00:00Z' };
const asMetric = (m: MetricInfo, value = 1): Metric => ({ id: m.id, label: m.label, value, unit: m.unit, business: m.business, period: '2026-09', source });
const all = Object.values(WORKERS);
const tools = (assistant: string) => createReadTools({ store: {} as never, brain: {} as never, data: null, now: () => new Date() }, assistant as never);

describe('the workers registry', () => {
  it('has the fifteen workers of the contract, each in the division its id names, with a focus and its families', () => {
    expect(Object.keys(WORKERS).sort()).toEqual([...WORKER_IDS].sort());
    for (const id of WORKER_IDS) {
      expect(WORKERS[id]).toMatchObject({ id, division: workerDivision(id) });
      expect(WORKERS[id].focus.length).toBeGreaterThan(10);
      expect(WORKERS[id].prefixes.length).toBeGreaterThan(0);
    }
  });

  it('every family matches at least one metric its division reads in the v2 catalog, apart from the ones the data lane adds in this wave', () => {
    const missing = all.flatMap((def) => def.prefixes
      .filter((p) => !PENDING_DATA_PREFIXES.includes(p) && !readBy(def.division).some((m) => m.id.startsWith(p)))
      .map((p) => `${def.id} ${p}`));
    expect(missing).toEqual([]);
  });

  it('a pending family matches nothing its division reads yet, and every pending family belongs to a worker: the merge empties the list', () => {
    const matching = all.flatMap((def) => def.prefixes
      .filter((p) => PENDING_DATA_PREFIXES.includes(p) && readBy(def.division).some((m) => m.id.startsWith(p)))
      .map((p) => `${def.id} ${p}`));
    expect(matching).toEqual([]); // a family that matches now is the data lane's: take it off PENDING_DATA_PREFIXES
    expect(PENDING_DATA_PREFIXES.filter((p) => !all.some((def) => def.prefixes.includes(p)))).toEqual([]);
  });

  it("keeps each worker's numbers to one business: no worker watches the salon and the online store together", () => {
    for (const def of all) {
      expect(new Set(def.prefixes.map((p) => p.slice(2, p.indexOf('.')))), def.id).toEqual(new Set([workerBusiness(def)]));
    }
    expect(workerBusiness(WORKERS['finance.salon_money'])).toBe('salon');
    expect(workerBusiness(WORKERS['finance.online_money'])).toBe('online');
  });

  it("never selects a metric outside its division's reads, even when a read hands it every metric of every division", () => {
    const everything = { metrics: catalog.map((m) => asMetric(m)), attention: [] };
    for (const def of all) {
      const kept = workerSlice(def, everything, catalog);
      const outside = kept.metrics.filter((m) => !readBy(def.division).some((r) => r.id === m.id) || !def.prefixes.some((p) => m.id.startsWith(p)));
      expect(outside.map((m) => m.id), def.id).toEqual([]);
    }
    // The total email sends are Online's alone. Merge wave 2: the data lane's email split (flow and campaign sends and
    // revenue, campaigns, unsubscribe rate) is read by Online and Finance (docs/wave2.md item 2), so George's email worker
    // keeps the email money and the split, and still never the total sends.
    expect(workerSlice(WORKERS['finance.email'], everything, catalog).metrics.map((m) => m.id).sort()).toEqual([
      'm:online.email.campaign.count', 'm:online.email.campaign.revenue', 'm:online.email.campaign.sends', 'm:online.email.flow.revenue',
      'm:online.email.flow.sends', 'm:online.email.revenue', 'm:online.email.unsubscribe_rate',
    ]);
    expect(workerSlice(WORKERS['online.messages'], everything, catalog).metrics.every((m) => m.id.startsWith('m:online.service.'))).toBe(true);
  });

  it('runs only read tools that exist (or that the data lane adds in this wave), each one its division may read', () => {
    const profiles = loadProfiles({});
    for (const def of all) {
      const existing = tools(DIVISION_ASSISTANT[def.division]);
      for (const r of def.rows) {
        if (existing[r.tool]) expect(profiles[def.division].reads, `${def.id} ${r.tool}`).toContain(r.tool);
        else expect(PENDING_ROW_TOOLS, `${def.id} ${r.tool}`).toContain(r.tool);
      }
      expect(def.rows.length).toBeLessThanOrEqual(4); // a report holds at most four row reads
    }
    // A pending tool that exists now is the data lane's: take it off PENDING_ROW_TOOLS (and check its arguments here).
    expect(PENDING_ROW_TOOLS.filter((name) => tools('finance')[name] || tools('online')[name] || tools('salon')[name])).toEqual([]);
  });

  it('keys the day\'s run by worker and day, and a run asked for by hand by its task too', () => {
    expect(workerKey('finance.google_ads', '2026-10-27')).toBe('worker:finance.google_ads:2026-10-27');
    expect(workerKey('salon.clients', '2026-10-27', '6f1d2c3b-0000-4000-8000-000000000001')).toBe('worker:salon.clients:2026-10-27:6f1d2c3b-0000-4000-8000-000000000001');
  });
});

describe("what a worker keeps of its division's read", () => {
  const def: WorkerDef = WORKERS['finance.google_ads'];
  const read = {
    metrics: readBy('finance').map((m, i) => asMetric(m, i + 10)),
    attention: [
      { metricId: 'm:online.budget.google.used', level: 'watch' as const, rule: 'Most of the Google budget is used.' },
      { metricId: 'm:salon.ap.overdue', level: 'act' as const, rule: 'Salon supplier bills are overdue.' },
    ],
  };

  it('its own families only, and only the attention rules that fired on them', () => {
    const kept = workerSlice(def, read, catalog);
    expect(kept.metrics.map((m) => m.id)).toEqual(read.metrics.map((m) => m.id).filter((id) => id.startsWith('m:online.ads.google.') || id.startsWith('m:online.budget.google.')));
    expect(kept.attention).toEqual([read.attention[0]]);
  });

  it('on a port without a catalog, its families of its own business', () => {
    const kept = workerSlice(WORKERS['finance.salon_money'], { metrics: [asMetric(catalog.find((m) => m.id === 'm:salon.revenue.total')!), asMetric(catalog.find((m) => m.id === 'm:online.revenue.total')!)], attention: [] });
    expect(kept.metrics.map((m) => m.id)).toEqual(['m:salon.revenue.total']);
  });

  it('keeps the totals of a row read as flat numbers, and nothing that is not a finite number', () => {
    expect(totalsAt({ totals: { count: 4, byChannel: { email: 3, sms: 1 }, note: 'x', missing: null, list: [1, 2] }, rows: [{ a: 9 }] }, 'totals'))
      .toEqual({ count: 4, 'byChannel.email': 3, 'byChannel.sms': 1 });
    expect(totalsAt({ channels: { google: { capUsd: 2500, spendUsd: 1800, roomUsd: 700, used: 0.72 }, meta: { capUsd: 900 } } }, 'channels.google'))
      .toEqual({ capUsd: 2500, spendUsd: 1800, roomUsd: 700, used: 0.72 });
    expect(totalsAt({ totals: { online: { count: 2, amountUsd: 3100 } } }, 'totals')).toEqual({ 'online.count': 2, 'online.amountUsd': 3100 });
    expect(totalsAt(null, 'totals')).toEqual({});
  });
});

describe("checking a worker's words", () => {
  const m = (id: string, value: number, unit: Metric['unit'], business: 'salon' | 'online', label = id): Metric => ({ id, label, value, unit, business, period: '2026-09', source });
  const src = {
    metrics: [m('m:online.ads.google.spend', 1800, 'usd', 'online'), m('m:online.ads.google.roas', 2.4, 'ratio', 'online'), m('m:online.budget.google.used', 0.72, 'ratio', 'online')],
    attention: [],
    rows: [{ read: 'budget_room.google', totals: { roomUsd: 700 } }],
    business: 'online' as const,
  };
  const words = (findings: { text: string; cites: string[] }[], headline = 'Google ads return 2.4x.') => ({ headline, findings });

  it('accepts words whose numbers were read (metrics and row totals) and whose cites are its own ids; a status from the model is dropped', () => {
    const raw = { ...words([{ text: 'Spend was $1,800 at 2.4x; 72% of the budget is used and $700 is left.', cites: ['m:online.ads.google.spend', 'm:online.budget.google.used'] }]), status: 'normal' };
    const check = checkWorkerWords(raw, src);
    expect(check).toEqual({ ok: true, words: words(raw.findings) });
  });

  it('refuses a number nobody read, a cite that is not its own, number words, medical words and a broken shape', () => {
    const check = checkWorkerWords(words([
      { text: 'Spend reached $9,999.', cites: ['m:online.ads.google.spend'] },
      { text: 'Email brought money.', cites: ['m:online.email.revenue'] },
      { text: 'Returns were seven.', cites: [] },
      { text: 'Hair loss buyers clicked.', cites: [] },
    ]), src);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.objections).toEqual([
      'finding 2: "m:online.email.revenue" is not one of your metric ids',
      'finding 1: "9,999" is not a number in the data',
      'finding 3: write "seven" in digits so it can be checked, and only if the number is in the data',
      'finding 4: no medical or hair-loss information belongs in a report',
    ]);
    expect(checkWorkerWords({ headline: '', findings: [] }, src)).toMatchObject({ ok: false, objections: [expect.stringMatching(/^headline: /)] });
    expect(checkWorkerWords(words(Array.from({ length: 6 }, () => ({ text: 'ok', cites: [] }))), src).ok).toBe(false);
  });

  it('refuses a sentence that puts a salon number next to an online number', () => {
    const mixed = { ...src, metrics: [...src.metrics, m('m:salon.revenue.total', 52000, 'usd', 'salon')] };
    const check = checkWorkerWords(words([{ text: 'Google spend was $1,800 while the salon made $52,000.', cites: [] }]), mixed);
    expect(check.ok ? [] : check.objections).toEqual(['finding 1: one sentence mixes a salon number and an online number (1,800, 52,000)']);
  });

  it('checks the words against the numbers the report keeps: its first 60 metrics, the attention rules on them and 4 row reads', () => {
    const many = Array.from({ length: 61 }, (_, i) => m(`m:online.email.n${i}`, 1000 + i, 'count', 'online', 'Email sends'));
    const rows = Array.from({ length: 5 }, (_, i) => ({ read: `r${i}`, totals: { count: 2000 + i } }));
    const kept = workerSource({ metrics: many, attention: [{ metricId: many[60]!.id, level: 'act', rule: 'Too many.' }, { metricId: many[0]!.id, level: 'watch', rule: 'Look.' }] }, rows, 'online');
    expect(kept.metrics).toEqual(many.slice(0, 60));
    expect(kept.attention).toEqual([{ metricId: many[0]!.id, level: 'watch', rule: 'Look.' }]);
    expect(kept.rows).toEqual(rows.slice(0, 4));
    expect(checkWorkerWords(words([], 'Sends reached 1059 and 2003.'), kept).ok).toBe(true);
    expect(checkWorkerWords(words([], 'Sends reached 1060 and 2004.'), kept)).toEqual({
      ok: false, objections: ['headline: "1060" is not a number in the data', 'headline: "2004" is not a number in the data'],
    });
  });

  it('writes the rule report from the attention rules and the metrics\' own labels and values', () => {
    const fired = { ...src, metrics: [m('m:online.budget.google.used', 0.72, 'ratio', 'online', 'Google budget used')], attention: [{ metricId: 'm:online.budget.google.used', level: 'watch' as const, rule: 'Most of the budget is used.' }] };
    expect(ruleWords(fired, 'watch')).toEqual({
      headline: 'Rule-written report, because the usual write-up did not pass its number check. Status: watch.',
      findings: [{ text: 'Google budget used is 0.72x. Rule that fired (watch): Most of the budget is used.', cites: ['m:online.budget.google.used'] }],
    });
  });
});

describe('the 07:00 clock', () => {
  it('holds the workers at 07:00 New York time, before the briefs', () => {
    expect(SCHEDULE[0]).toMatchObject({ name: 'division-workers', at: '07:00' });
    expect(dueJobs(new Date('2026-10-27T10:59:00Z')).map((d) => d.job.name)).toEqual([]); // 06:59 EDT
    expect(dueJobs(new Date('2026-10-27T11:00:00Z')).map((d) => d.job.name)).toEqual(['division-workers']);
  });

  it('queues each of the fifteen workers once a day, for its division\'s assistant, under its day\'s key', async () => {
    const enqueued: { assistant: string; key: string; payload: Record<string, unknown> }[] = [];
    const receipts: Receipt[] = [];
    const deps = {
      now: () => new Date('2026-10-27T11:00:00Z'), live: false,
      store: { enqueueTask: async (t: { assistant: string; key: string; payload: Record<string, unknown> }) => { enqueued.push(t); }, receipt: async (r: Receipt) => { receipts.push(r); } },
    } as unknown as WorkerDeps;
    const queued = new Set<string>();
    expect(await runDueJobs(deps, queued)).toEqual(['division-workers']);
    expect(await runDueJobs(deps, queued)).toEqual([]); // the next tick queues nothing more
    expect(enqueued.map((t) => t.key)).toEqual(WORKER_IDS.map((id) => `worker:${id}:2026-10-27`));
    expect(enqueued.map((t) => t.assistant)).toEqual(WORKER_IDS.map((id) => DIVISION_ASSISTANT[workerDivision(id)]));
    expect(enqueued[0]!.payload).toEqual({ job: 'division_worker', worker: 'finance.email', date: '2026-10-27' });
    expect(receipts.map((r) => r.detail)).toEqual(['division-workers for 2026-10-27 queued']);
  });
});
