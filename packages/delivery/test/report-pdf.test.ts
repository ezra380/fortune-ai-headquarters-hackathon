import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MANAGERS, WORKER_IDS, type ManagedDivision, type ReportContext } from '@fahq/contracts';
import { createDeliveryPort, formatValue, WORKER_LABEL } from '../src/index.ts';
import { wrap } from '../src/pdf.ts';
import { pdfPages, pdfText } from './pdf-text.ts';
import { weeklyReport, workerReport, workerReportsOf, WORKERS_OF } from './report-fixtures.ts';

const port = createDeliveryPort({} as NodeJS.ProcessEnv, { fetch, now: () => new Date('2026-10-26T12:00:00Z'), sentLedger: new Set<string>() });
const ctxOf = (d: ManagedDivision): ReportContext => ({ manager: MANAGERS[d].manager, head: MANAGERS[d].head, divisionTitle: MANAGERS[d].title });
const DIVISIONS: ManagedDivision[] = ['finance', 'online', 'salon'];

describe('numbers by unit', () => {
  const at = (unit: Parameters<typeof formatValue>[0]['unit'], value: number, id = 'm:online.x') => formatValue({ id, value, unit });

  it('writes dollars, counts and percents the way a person reads them', () => {
    expect(at('usd', 12400)).toBe('$12,400');
    expect(at('usd', 2.4)).toBe('$2.40');
    expect(at('usd', 1234567.89)).toBe('$1,234,568');
    expect(at('usd', -950)).toBe('-$950');
    expect(at('count', 61200)).toBe('61,200');
    expect(at('percent', 4.25)).toBe('4.3%');
    expect(at('percent', 18)).toBe('18%');
  });

  it('writes a ratio as a percent, and an ad return or an index as a multiple', () => {
    expect(at('ratio', 0.52)).toBe('52%');
    expect(at('ratio', 0.003)).toBe('0.3%');
    expect(at('ratio', 0.043)).toBe('4.3%');
    expect(at('ratio', 3.1, 'm:online.ads.google.roas')).toBe('3.1x');
    expect(at('ratio', 3.4, 'm:online.mer')).toBe('3.4x');
    expect(at('ratio', 0.9, 'm:salon.season.month_index')).toBe('0.9x');
  });

  it('writes minutes, days, seconds and scores with their unit', () => {
    expect(at('minutes', 85)).toBe('85 min');
    expect(at('days', 11.5)).toBe('11.5 days');
    expect(at('days', 1)).toBe('1 day');
    expect(at('seconds', 2.8)).toBe('2.8 s');
    expect(at('score', 4.6)).toBe('4.6');
  });
});

describe('line wrapping', () => {
  it('cuts a word wider than the line into pieces that fit, and loses nothing', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const word = 'W'.repeat(150);
    const rows = wrap(`short ${word} end`, font, 10, 200);
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(font.widthOfTextAtSize(row, 10)).toBeLessThanOrEqual(200);
    expect(rows.join(' ').replace(/\s/g, '')).toBe(`short${word}end`);
  });
});

describe('worker report PDF', () => {
  it('is one page with the headline, findings, rule and numbers', async () => {
    const report = workerReport('finance.google_ads');
    const bytes = await port.renderWorkerReportPdf(report, ctxOf('finance'));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const pages = await pdfPages(bytes);
    expect(pages).toHaveLength(1);
    const text = pages[0]!;
    expect(text).toContain('Google Ads');
    expect(text).toContain(report.headline);
    expect(text).toContain('$9,200 of spend brought $28,520 of revenue');
    expect(text).toContain('The Google budget is mostly spent');
    // the key numbers table: label and value, written by unit
    expect(text).toContain('Google ad spend');
    expect(text).toContain('$9,200');
    expect(text).toContain('3.1x');
    expect(text).toContain('80%');
  });

  it('shows each finding with the numbers it cites, so every number can be traced', async () => {
    const text = await pdfText(await port.renderWorkerReportPdf(workerReport('online.messages'), ctxOf('online')));
    expect(text).toMatch(/Based on: .*Customer messages answered within the hour 52%/);
  });

  it('says when a program, not a model, wrote the report', async () => {
    const text = await pdfText(await port.renderWorkerReportPdf(workerReport('finance.meta', { writtenBy: 'rule' }), ctxOf('finance')));
    expect(text).toContain('written from the rules');
  });

  it('every worker has a label and a report that renders', async () => {
    for (const id of WORKER_IDS) {
      expect(WORKER_LABEL[id].length).toBeGreaterThan(2);
      const text = await pdfText(await port.renderWorkerReportPdf(workerReport(id), ctxOf(id.split('.')[0] as ManagedDivision)));
      expect(text).toContain(WORKER_LABEL[id]);
    }
  });
});

describe('weekly packet PDF', () => {
  it.each(DIVISIONS)('renders the %s packet: the manager first, then one page per worker', async (division) => {
    const weekly = weeklyReport(division);
    const bytes = await port.renderWeeklyPacketPdf(weekly, workerReportsOf(division), ctxOf(division));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const pages = await pdfPages(bytes);
    const first = pages[0]!;
    expect(first).toContain(`${MANAGERS[division].title} weekly report`);
    expect(first).toContain(`${MANAGERS[division].manager}'s report to ${MANAGERS[division].head}`);
    expect(first).toContain(weekly.summary);
    const workerPages = pages.filter((p) => p.includes('Daily report for'));
    expect(workerPages).toHaveLength(WORKERS_OF[division].length);
    // the workers come last, in the order of the registry
    expect(pages.slice(pages.length - workerPages.length)).toEqual(workerPages);
    WORKERS_OF[division].forEach((id, i) => expect(workerPages[i]).toContain(WORKER_LABEL[id]));
  });

  it("George's packet carries the goal of the week and three paths with their test, stop-loss and actions", async () => {
    const weekly = weeklyReport('finance');
    const text = await pdfText(await port.renderWeeklyPacketPdf(weekly, workerReportsOf('finance'), ctxOf('finance')));
    expect(text).toContain('Goal of the week');
    expect(text).toContain(weekly.goal!.title);
    expect(text).toContain('from $21,300 to $24,000 by');
    for (const path of weekly.paths!.plans) {
      expect(text).toContain(`Path ${path.rank}`);
      expect(text).toContain(path.title);
      expect(text).toContain(path.test);
      expect(text).toContain(path.stopLoss);
      for (const action of path.actions) expect(text).toContain(action);
    }
    expect(text).toContain('Reply APPROVE 1, 2 or 3');
  });

  it('shows the actions of Online and Salon, and what was asked of other divisions', async () => {
    const online = weeklyReport('online');
    const text = await pdfText(await port.renderWeeklyPacketPdf(online, workerReportsOf('online'), ctxOf('online')));
    for (const action of online.actions) expect(text).toContain(action.title);
    expect(text).toContain('Asked of other divisions');
    expect(text).toContain(online.asked[0]!.question);
    expect(text).toContain('No answer');
    expect(text).not.toContain('Goal of the week');
  });

  it('skips the empty parts: a salon report with nothing asked has no "asked" heading', async () => {
    const text = await pdfText(await port.renderWeeklyPacketPdf(weeklyReport('salon'), workerReportsOf('salon'), ctxOf('salon')));
    expect(text).not.toContain('Asked of other divisions');
  });

  it('says plainly when a worker report could not be loaded', async () => {
    const reports = workerReportsOf('salon').slice(0, 2);
    const text = await pdfText(await port.renderWeeklyPacketPdf(weeklyReport('salon'), reports, ctxOf('salon')));
    expect(text).toMatch(/1 of 3 worker reports could not be loaded/);
  });

  it('never prints a phone number, an email address or a code, even if the words carry one', async () => {
    const dirty = workerReport('finance.email', {
      headline: 'Call +1 (555) 010-0199 about the code 482913 or write to alan@example.com',
      findings: [{ text: 'Phone 555-010-0123, code 123 456, mail someone@example.com.', cites: [] }],
    });
    const weekly = weeklyReport('finance', { summary: 'Text 5550100199 and email boss@example.com; code 654321.' });
    const bytes = await port.renderWeeklyPacketPdf(weekly, [dirty], ctxOf('finance'));
    const text = await pdfText(bytes);
    for (const secret of ['555', '482913', '123 456', '654321', '@example.com', '0199']) expect(text).not.toContain(secret);
    expect(text).toContain('[phone]');
    expect(text).toContain('[email]');
    expect(text).toContain('[code]');
    // an amount is not a code
    expect(text).toContain('$21,300');
  });

  it('renders text that standard fonts cannot encode, and keeps the numbers table to the key numbers', async () => {
    const long = workerReport('finance.email', {
      headline: 'Email “earned” $25,300 — a record 🙂',
      metrics: Array.from({ length: 40 }, (_, i) => ({ ...workerReport('finance.email').metrics[0]!, id: `m:online.email.n${i}`, label: `Metric number ${i}` })),
    });
    const bytes = await port.renderWeeklyPacketPdf(weeklyReport('finance'), [long], ctxOf('finance'));
    const text = await pdfText(bytes);
    expect(text).toContain('Email "earned" $25,300 - a record');
    // the table is kept to the numbers that matter, with a plain note of how many more there are
    expect(text).toMatch(/\d+ more numbers? in the data/);
  });

  it('writes the same bytes for the same report (the PDF carries no clock)', async () => {
    const make = () => port.renderWeeklyPacketPdf(weeklyReport('online'), workerReportsOf('online'), ctxOf('online'));
    expect(Buffer.from(await make()).equals(Buffer.from(await make()))).toBe(true);
  });
});
