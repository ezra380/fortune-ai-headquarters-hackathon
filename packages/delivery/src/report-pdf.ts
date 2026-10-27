import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Division, Metric, ReportContext, ReportStatus, WeeklyReport, WorkerReport } from '@fahq/contracts';
import { formatValue, longDate, money, WORKER_LABEL } from './format.ts';
import { toWinAnsi, wrap } from './pdf.ts';
import { scrub } from './scrub.ts';

// The report PDFs: a worker's daily report (one page) and the manager's weekly packet (the weekly report first,
// then one page per worker report). On the Fortune Wigs brand kit: only its palette, and the standard PDF fonts
// stand in for its two typefaces (Times for Playfair Display, Helvetica for Lato). Nothing here reads a clock, so
// the same report always makes the same bytes. No phone number, email address or code is ever drawn: every
// string passes `clean` on its way to the page.

const hex = (code: string) => rgb(parseInt(code.slice(1, 3), 16) / 255, parseInt(code.slice(3, 5), 16) / 255, parseInt(code.slice(5, 7), 16) / 255);
/** Brand kit section 5: the only colors, each used for its role (ink for text, teal for accents, panels carry ink). */
const COLOR = {
  ink: hex('#212424'), muted: hex('#5B5F60'), teal: hex('#5699A9'), panel: hex('#CCE0E5'), panelSoft: hex('#D6E1E2'),
  canvas: hex('#F0F1F3'), hairline: hex('#DADADA'), white: hex('#FFFFFF'),
};

const PAGE = { width: 612, height: 792, margin: 54, bottom: 62 };
const CONTENT = PAGE.width - PAGE.margin * 2;
const KEY_NUMBERS = 12;

type Face = 'body' | 'bold' | 'serif';
type Color = ReturnType<typeof hex>;
type TextOptions = { size?: number; face?: Face; color?: Color; indent?: number; width?: number; gap?: number };

/** What a person may see of a string: nothing `scrub` removes, and only characters the fonts can draw. */
const clean = (text: string): string => toWinAnsi(scrub(text));

const STATUS_WORDS: Record<ReportStatus, { pill: string; line: string }> = {
  normal: { pill: 'ON TRACK', line: 'Nothing here needs a decision.' },
  watch: { pill: 'WORTH A LOOK', line: 'A fixed data rule is flagging something.' },
  act: { pill: 'NEEDS ACTION', line: 'A fixed data rule says something here needs a decision.' },
};
const DIVISION_NAME: Record<Division, string> = { salon: 'Salon', finance: 'Finance', online: 'Online', hq: 'HQ' };
const WRITTEN_BY_RULE = "This report was written from the rules by a program, because the model's words did not pass their number check.";

class Sheet {
  page!: PDFPage;
  y = 0;
  constructor(private readonly doc: PDFDocument, private readonly fonts: Record<Face, PDFFont>) {}

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.page.drawRectangle({ x: 0, y: PAGE.height - 8, width: PAGE.width, height: 8, color: COLOR.teal });
    this.y = PAGE.height - PAGE.margin - 6;
  }

  /** Starts a new page unless `height` still fits on this one. */
  room(height: number) {
    if (this.y - height < PAGE.bottom) this.newPage();
  }

  rows(text: string, o: TextOptions): string[] {
    const size = o.size ?? 10.5;
    return wrap(clean(text), this.fonts[o.face ?? 'body'], size, (o.width ?? CONTENT) - (o.indent ?? 0));
  }

  text(text: string, o: TextOptions = {}) {
    const size = o.size ?? 10.5;
    const lineHeight = size * 1.38;
    for (const row of this.rows(text, o)) {
      this.room(lineHeight);
      this.page.drawText(row, { x: PAGE.margin + (o.indent ?? 0), y: this.y - size, size, font: this.fonts[o.face ?? 'body'], color: o.color ?? COLOR.ink });
      this.y -= lineHeight;
    }
    this.y -= o.gap ?? 4;
  }

  heading(text: string) {
    this.room(80);
    this.y -= 6;
    this.text(text, { size: 13, face: 'serif', gap: 2 });
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y + 1 }, end: { x: PAGE.margin + CONTENT, y: this.y + 1 }, thickness: 0.6, color: COLOR.hairline });
    this.y -= 6;
  }

  bullets(items: readonly string[], o: TextOptions = {}) {
    for (const item of items) this.text(`-  ${item}`, { ...o, indent: 10, gap: 2 });
    this.y -= 2;
  }

  /** A filled box: every line is measured first so the box is never split across pages. */
  panel(fill: Color, items: readonly { text: string; o?: TextOptions }[]) {
    const pad = 11;
    // The text is measured with the very options it is drawn with, so the box always fits it.
    const measured = items.map(({ text, o }) => ({ text, o: { ...o, indent: pad, width: CONTENT - pad } }));
    const height = pad * 2 + measured.reduce((sum, m) => sum + this.rows(m.text, m.o).length * (m.o.size ?? 10.5) * 1.38 + (m.o.gap ?? 4), 0);
    this.room(height);
    this.page.drawRectangle({ x: PAGE.margin, y: this.y - height, width: CONTENT, height, color: fill });
    this.y -= pad;
    for (const m of measured) this.text(m.text, m.o);
    this.y -= pad + 6;
  }

  pill(status: ReportStatus) {
    const { pill } = STATUS_WORDS[status];
    const size = 8.5;
    const font = this.fonts.bold;
    const width = font.widthOfTextAtSize(pill, size) + 18;
    const style = status === 'act' ? { fill: COLOR.ink, text: COLOR.white } : status === 'watch' ? { fill: COLOR.panel, text: COLOR.ink } : { fill: COLOR.panelSoft, text: COLOR.ink };
    this.room(24);
    this.page.drawRectangle({ x: PAGE.margin, y: this.y - 17, width, height: 17, color: style.fill, borderColor: status === 'watch' ? COLOR.teal : undefined, borderWidth: status === 'watch' ? 1 : 0 });
    this.page.drawText(pill, { x: PAGE.margin + 9, y: this.y - 12, size, font, color: style.text });
    this.page.drawText(clean(STATUS_WORDS[status].line), { x: PAGE.margin + width + 10, y: this.y - 12, size: 9.5, font: this.fonts.body, color: COLOR.muted });
    this.y -= 30;
  }

  /** A table with a header row and zebra stripes; a long cell wraps, a row never splits across pages, and column `rightCol` is right-aligned. */
  table(head: readonly string[], body: readonly (readonly string[])[], widths: readonly number[], rightCol = 1) {
    const size = 9;
    const lineHeight = size * 1.35;
    const draw = (cells: readonly string[], fill: Color | null, face: Face) => {
      const font = this.fonts[face];
      const columns = cells.map((cell, i) => wrap(clean(cell), font, size, widths[i]! - 12));
      const height = Math.max(...columns.map((c) => c.length)) * lineHeight + 8;
      this.room(height);
      if (fill) this.page.drawRectangle({ x: PAGE.margin, y: this.y - height, width: CONTENT, height, color: fill });
      let x = PAGE.margin;
      columns.forEach((rows, i) => {
        rows.forEach((row, n) => {
          const left = i === rightCol ? x + widths[i]! - 6 - font.widthOfTextAtSize(row, size) : x + 6;
          this.page.drawText(row, { x: left, y: this.y - 4 - size - n * lineHeight, size, font, color: COLOR.ink });
        });
        x += widths[i]!;
      });
      this.y -= height;
    };
    draw(head, COLOR.panelSoft, 'bold');
    body.forEach((cells, i) => draw(cells, i % 2 ? COLOR.canvas : null, 'body'));
    this.y -= 8;
  }
}

async function newSheet(title: string): Promise<{ pdf: PDFDocument; sheet: Sheet; font: PDFFont }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(toWinAnsi(title));
  pdf.setProducer('Fortune AI Headquarters');
  pdf.setCreator('Fortune AI Headquarters');
  const fonts = { body: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), serif: await pdf.embedFont(StandardFonts.TimesRomanBold) };
  return { pdf, sheet: new Sheet(pdf, fonts), font: fonts.body };
}

/** The footer of every page, drawn last so it can say "page 2 of 9". */
function footers(pdf: PDFDocument, font: PDFFont, label: string) {
  const pages = pdf.getPages();
  pages.forEach((page, i) => {
    page.drawLine({ start: { x: PAGE.margin, y: 44 }, end: { x: PAGE.margin + CONTENT, y: 44 }, thickness: 0.6, color: COLOR.hairline });
    page.drawText(clean(`Fortune AI Headquarters  ·  Synthetic data  ·  ${label}`), { x: PAGE.margin, y: 30, size: 8, font, color: COLOR.muted });
    const right = `Page ${i + 1} of ${pages.length}`;
    page.drawText(right, { x: PAGE.margin + CONTENT - font.widthOfTextAtSize(right, 8), y: 30, size: 8, font, color: COLOR.muted });
  });
}

const byId = (metrics: readonly Metric[]) => new Map(metrics.map((m) => [m.id, m]));

/** "Google ad spend $9,200; Google ad return 3.1x": the numbers a sentence rests on, written as the report holds them. */
function basedOn(cites: readonly string[], metrics: ReadonlyMap<string, Metric>): string {
  return [...new Set(cites)].map((id) => { const m = metrics.get(id); return m ? `${m.label} ${formatValue(m)}` : id; }).join('; ');
}

const ranks = (n: readonly number[]) => (n.length < 2 ? `${n[0]}` : `${n.slice(0, -1).join(', ')} or ${n.at(-1)}`);

// ---- one worker's page ---------------------------------------------------------------------

export function keyMetrics(report: WorkerReport): { shown: Metric[]; more: number } {
  const metrics = byId(report.metrics);
  const picked = new Map<string, Metric>();
  // The numbers the words and the rules lean on come first; the rest follow in the order the data gave them.
  for (const id of [...report.findings.flatMap((f) => f.cites), ...report.attention.map((a) => a.metricId)]) {
    const m = metrics.get(id);
    if (m) picked.set(id, m);
  }
  for (const m of report.metrics) picked.set(m.id, m);
  const all = [...picked.values()];
  return { shown: all.slice(0, KEY_NUMBERS), more: Math.max(0, all.length - KEY_NUMBERS) };
}

export const rowKey = (key: string) => key.replace(/_usd$/, '').replace(/_/g, ' ');
export const rowValue = (key: string, value: number) => (key.endsWith('_usd') ? money(value) : value.toLocaleString('en-US', { maximumFractionDigits: 2 }));

function workerPage(sheet: Sheet, report: WorkerReport, ctx: ReportContext) {
  const metrics = byId(report.metrics);
  sheet.newPage();
  sheet.text(`${ctx.divisionTitle.toUpperCase()}  ·  ${ctx.manager}'s workers`, { size: 8.5, color: COLOR.muted, gap: 6 });
  sheet.text(WORKER_LABEL[report.workerId], { size: 22, face: 'serif', gap: 2 });
  sheet.text(`Daily report for ${longDate(report.day)}  ·  numbers from ${report.period}`, { size: 10.5, color: COLOR.muted, gap: 10 });
  sheet.pill(report.status);
  if (report.writtenBy === 'rule') sheet.text(WRITTEN_BY_RULE, { size: 9, color: COLOR.muted, gap: 8 });
  sheet.text(report.headline, { size: 13, face: 'bold', gap: 8 });

  if (report.findings.length) {
    sheet.heading('What the worker found');
    report.findings.forEach((f, i) => {
      sheet.text(`${i + 1}.  ${f.text}`, { gap: 1 });
      if (f.cites.length) sheet.text(`Based on: ${basedOn(f.cites, metrics)}`, { size: 8.5, color: COLOR.muted, indent: 16, gap: 6 });
    });
  }
  if (report.attention.length) {
    sheet.heading('Rules that fired');
    for (const a of report.attention) sheet.text(`${a.level === 'act' ? 'Needs action' : 'Worth a look'}:  ${a.rule}  (${basedOn([a.metricId], metrics)})`, { gap: 3 });
  }

  const { shown, more } = keyMetrics(report);
  sheet.heading('Key numbers');
  sheet.table(['Number', 'Value', 'Metric id'], shown.map((m) => [m.label, formatValue(m), m.id]), [230, 80, 194]);
  if (more) sheet.text(`${more} more number${more === 1 ? '' : 's'} in the data.`, { size: 8.5, color: COLOR.muted });
  for (const r of report.rows) {
    sheet.heading(`Row totals: ${r.read}`);
    sheet.table(['Total', 'Value'], Object.entries(r.totals).map(([key, value]) => [rowKey(key), rowValue(key, value)]), [330, 174]);
  }
  sheet.text(`Source: ${sourceText(report)}`, { size: 8.5, color: COLOR.muted });
}

/** The data source as the report holds it (view#hash, system-made); anything else is cleaned like all text. */
export const sourceText = (report: Pick<WorkerReport, 'dataSource' | 'metrics'>): string => {
  const asOf = report.metrics[0]?.source.asOf.slice(0, 10);
  const source = /^[a-z0-9_.]+#[0-9a-f]{12}$/.test(report.dataSource) ? report.dataSource : clean(report.dataSource);
  return asOf ? `${source}, as of ${asOf}` : source;
};

// ---- the weekly report's first pages -------------------------------------------------------

function goalPanel(sheet: Sheet, weekly: WeeklyReport) {
  const goal = weekly.goal!;
  const metric = byId(weekly.metrics).get(goal.metricId);
  const at = (value: number) => (metric ? formatValue({ id: metric.id, unit: metric.unit, value }) : value.toLocaleString('en-US', { maximumFractionDigits: 2 }));
  sheet.heading('Goal of the week');
  sheet.panel(COLOR.panel, [
    { text: goal.title, o: { size: 14, face: 'serif', gap: 6 } },
    { text: `${metric?.label ?? goal.metricId}: from ${at(goal.from)} to ${at(goal.to)} by ${longDate(goal.by)}`, o: { face: 'bold', gap: 6 } },
    { text: goal.why },
  ]);
}

function pathBlocks(sheet: Sheet, weekly: WeeklyReport) {
  const metrics = byId(weekly.metrics);
  const plans = [...weekly.paths!.plans].sort((a, b) => a.rank - b.rank);
  sheet.heading('Three paths to the goal');
  for (const plan of plans) {
    sheet.room(140);
    sheet.panel(COLOR.canvas, [{ text: `Path ${plan.rank}   ${plan.title}`, o: { size: 12, face: 'bold', gap: 0 } }]);
    sheet.text(plan.summary, { gap: 5 });
    sheet.text('What to do', { face: 'bold', size: 10, gap: 1 });
    sheet.bullets(plan.actions);
    sheet.text('The numbers behind it', { face: 'bold', size: 10, gap: 1 });
    sheet.bullets(plan.evidence.map((e) => { const m = metrics.get(e.metricId); return `${m?.label ?? e.metricId}: ${m ? formatValue(m) : e.value.toLocaleString('en-US')}`; }), { size: 9.5 });
    for (const p of plan.projections) {
      const base = metrics.get(p.baseMetricId);
      const result = base?.unit === 'usd' ? money(p.result) : p.result.toLocaleString('en-US', { maximumFractionDigits: 2 });
      sheet.text(`${p.label}: ${base ? formatValue(base) : p.baseMetricId} x ${p.factor} = ${result}`, { size: 9.5, indent: 10, gap: 0 });
      sheet.text(`Assumption: ${p.assumption}`, { size: 8.5, color: COLOR.muted, indent: 10, gap: 5 });
    }
    sheet.text(`Test: ${plan.test}`, { gap: 2 });
    sheet.text(`Stop-loss: ${plan.stopLoss}`, { gap: 2 });
    if (plan.risks.length) sheet.text(`Risks: ${plan.risks.join('; ')}`, { size: 9.5, color: COLOR.muted, gap: 10 });
  }
  sheet.text(`Reply APPROVE ${ranks(plans.map((p) => p.rank))} with the one-time code sent to your phone to choose a path. Nothing is carried out until you decide.`, { size: 9.5, color: COLOR.muted });
}

function actionBlocks(sheet: Sheet, weekly: WeeklyReport) {
  const metrics = byId(weekly.metrics);
  const actions = [...weekly.actions].sort((a, b) => a.rank - b.rank);
  sheet.heading('Actions for you');
  for (const a of actions) {
    sheet.room(100);
    sheet.panel(COLOR.canvas, [{ text: `Action ${a.rank}   ${a.title}`, o: { size: 12, face: 'bold', gap: 0 } }]);
    sheet.text(a.why, { gap: 2 });
    sheet.text(`How: ${a.steps}`, { gap: 2 });
    if (a.cites.length) sheet.text(`Based on: ${basedOn(a.cites, metrics)}`, { size: 8.5, color: COLOR.muted, gap: 10 });
  }
  if (actions.length) sheet.text(`Reply APPROVE ${ranks(actions.map((a) => a.rank))} with the one-time code sent to your phone to approve an action. The program carries nothing out; you do.`, { size: 9.5, color: COLOR.muted });
}

function askedBlock(sheet: Sheet, weekly: WeeklyReport) {
  sheet.heading('Asked of other divisions');
  for (const a of weekly.asked) {
    sheet.room(60);
    sheet.text(`To ${DIVISION_NAME[a.division]}: ${a.question}`, { face: 'bold', size: 10, gap: 1 });
    sheet.text(a.ok ? a.answer : `No answer. ${a.answer}`, { indent: 10, gap: 6 });
  }
}

function sectionsBlock(sheet: Sheet, weekly: WeeklyReport) {
  const metrics = byId(weekly.metrics);
  sheet.heading('What each worker found');
  for (const s of weekly.sections) {
    sheet.room(64);
    sheet.text(`${WORKER_LABEL[s.workerId]}  (${STATUS_WORDS[s.status].pill.toLowerCase()})`, { face: 'bold', size: 10, gap: 1 });
    sheet.text(s.summary, { gap: 1 });
    if (s.cites.length) sheet.text(`Based on: ${basedOn(s.cites, metrics)}`, { size: 8.5, color: COLOR.muted, gap: 6 });
  }
}

function weeklyCover(sheet: Sheet, weekly: WeeklyReport, ctx: ReportContext, loaded: number) {
  sheet.newPage();
  sheet.text('FORTUNE AI HEADQUARTERS  ·  SYNTHETIC DATA', { size: 8.5, color: COLOR.muted, gap: 8 });
  sheet.text(`${ctx.divisionTitle} weekly report`, { size: 28, face: 'serif', gap: 3 });
  sheet.text(`${ctx.manager}'s report to ${ctx.head}`, { size: 13, gap: 2 });
  sheet.text(`Week of ${longDate(weekly.weekOf)}  ·  numbers from ${weekly.period}`, { size: 10.5, color: COLOR.muted, gap: 12 });
  sheet.pill(weekly.status);
  if (weekly.writtenBy === 'rule') sheet.text(WRITTEN_BY_RULE, { size: 9, color: COLOR.muted, gap: 8 });
  if (loaded < weekly.workerReportIds.length) {
    sheet.text(`${weekly.workerReportIds.length - loaded} of ${weekly.workerReportIds.length} worker reports could not be loaded, so their pages are missing from this packet.`, { size: 9.5, face: 'bold', gap: 8 });
  }
  sheet.heading('Summary');
  sheet.text(weekly.summary, { size: 11.5, gap: 8 });
  if (weekly.goal && weekly.paths) {
    goalPanel(sheet, weekly);
    pathBlocks(sheet, weekly);
  } else if (weekly.actions.length) actionBlocks(sheet, weekly);
  if (weekly.asked.length) askedBlock(sheet, weekly);
  sectionsBlock(sheet, weekly);
  sheet.text(`Source: ${sourceText(weekly)}`, { size: 8.5, color: COLOR.muted });
}

// ---- the two documents ---------------------------------------------------------------------

/** Both documents carry the report's own date, never the clock, so the same report is always the same file. */
const stamp = (pdf: PDFDocument, day: string) => {
  const date = new Date(`${day}T12:00:00Z`);
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
};

export async function renderWorkerReportPdf(report: WorkerReport, ctx: ReportContext): Promise<Uint8Array> {
  const { pdf, sheet, font } = await newSheet(`${ctx.divisionTitle}: ${WORKER_LABEL[report.workerId]} daily report`);
  stamp(pdf, report.day);
  workerPage(sheet, report, ctx);
  footers(pdf, font, `${WORKER_LABEL[report.workerId]} daily report, ${report.day}`);
  return pdf.save();
}

export async function renderWeeklyPacketPdf(weekly: WeeklyReport, workerReports: readonly WorkerReport[], ctx: ReportContext): Promise<Uint8Array> {
  const { pdf, sheet, font } = await newSheet(`${ctx.divisionTitle} weekly report, week of ${weekly.weekOf}`);
  stamp(pdf, weekly.weekOf);
  weeklyCover(sheet, weekly, ctx, workerReports.length);
  for (const report of workerReports) workerPage(sheet, report, ctx);
  footers(pdf, font, `${ctx.divisionTitle} weekly report, week of ${weekly.weekOf}`);
  return pdf.save();
}
