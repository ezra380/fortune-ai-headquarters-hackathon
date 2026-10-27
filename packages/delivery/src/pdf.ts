import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Metric, ProposalDocument } from '@fahq/contracts';

// The printed proposal: a cover, one page per plan (evidence with its source, projections as
// arithmetic, levers as choices to approve), and a closing page. Standard fonts only speak WinAnsi,
// so text is mapped to it first and rendering never throws on unusual characters.

const PAGE = { width: 612, height: 792, margin: 54 };
const INK = rgb(0.13, 0.13, 0.13);
const MUTED = rgb(0.42, 0.42, 0.42);

const REPLACEMENTS: Record<string, string> = {
  '×': 'x', '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '-',
  '→': '->', '←': '<-', '≥': '>=', '≤': '<=', ' ': ' ', ' ': ' ', ' ': ' ',
};

export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKC')) {
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (ch === '\n' || (ch >= ' ' && ch <= '~')) out += ch;
    else if (ch.charCodeAt(0) >= 0xa0 && ch.charCodeAt(0) <= 0xff) out += ch;
    // anything else (emoji, symbols outside WinAnsi) is dropped
  }
  return out;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function formatMetric(m: Pick<Metric, 'value' | 'unit'>): string {
  if (m.unit === 'usd') return money(m.value);
  if (m.unit === 'percent') return `${m.value}%`;
  if (m.unit === 'ratio') return `${m.value}x`;
  if (m.unit === 'minutes') return `${m.value.toLocaleString('en-US')} min`;
  if (m.unit === 'days') return `${m.value.toLocaleString('en-US')} days`;
  if (m.unit === 'seconds') return `${m.value.toLocaleString('en-US')} s`;
  return m.value.toLocaleString('en-US');
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private readonly doc: PDFDocument, private readonly font: PDFFont, private readonly bold: PDFFont) {}

  newPage(footer: string) {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
    this.page.drawText(toWinAnsi(footer), { x: PAGE.margin, y: 30, size: 8, font: this.font, color: MUTED });
  }

  line(text: string, opts: { size?: number; bold?: boolean; color?: typeof INK; gap?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    for (const row of wrap(toWinAnsi(text), font, size, PAGE.width - PAGE.margin * 2)) {
      if (this.y < PAGE.margin + 20) this.newPage('continued');
      this.page.drawText(row, { x: PAGE.margin, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size * 1.35;
    }
    this.y -= opts.gap ?? 2;
  }
}

/** A word wider than the line (a long id, a pasted address) is cut into pieces that fit, so it never runs off the page. */
function breakWord(word: string, font: PDFFont, size: number, width: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const ch of word) {
    if (piece && font.widthOfTextAtSize(piece + ch, size) > width) {
      pieces.push(piece);
      piece = ch;
    } else piece += ch;
  }
  return [...pieces, piece];
}

export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    let row = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = row ? `${row} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        row = next;
        continue;
      }
      if (row) rows.push(row);
      const pieces = font.widthOfTextAtSize(word, size) > width ? breakWord(word, font, size, width) : [word];
      rows.push(...pieces.slice(0, -1));
      row = pieces.at(-1)!;
    }
    rows.push(row);
  }
  return rows;
}

export async function renderProposalPdf(doc: ProposalDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(toWinAnsi(doc.title));
  pdf.setProducer('Fortune AI Headquarters');
  const w = new Writer(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold));
  const footer = `SYNTHETIC DATA  ·  proposal ${doc.proposalId.slice(0, 8)}  ·  every number traces to a cited source, a computed projection or a declared choice`;
  const byId = new Map(doc.citedMetrics.map((m) => [m.id, m]));

  w.newPage(footer);
  w.line(doc.title, { size: 22, bold: true, gap: 10 });
  w.line(`Requested by ${doc.requestedBy}`, { size: 12 });
  w.line(`Prepared by ${doc.preparedBy}`, { size: 12 });
  w.line(`Created ${new Date(doc.createdAt).toUTCString()}`, { size: 10, color: MUTED, gap: 16 });
  for (const p of [...doc.plans.plans].sort((a, b) => a.rank - b.rank)) w.line(`${p.rank}.  ${p.title}`, { size: 13, gap: 6 });
  const source = doc.citedMetrics[0]?.source;
  if (source) w.line(`Numbers from ${source.view} (query ${source.queryHash.slice(0, 12)}), as of ${source.asOf}`, { size: 9, color: MUTED });

  for (const plan of [...doc.plans.plans].sort((a, b) => a.rank - b.rank)) {
    w.newPage(footer);
    w.line(`Plan ${plan.rank}`, { size: 11, color: MUTED });
    w.line(plan.title, { size: 18, bold: true, gap: 6 });
    w.line(`Touches: ${plan.businesses.join(' and ')}`, { size: 9, color: MUTED, gap: 8 });
    w.line(plan.summary, { gap: 10 });

    w.line('What to do', { bold: true });
    for (const a of plan.actions) w.line(`-  ${a}`);
    w.y -= 6;

    w.line('Evidence (from the business data)', { bold: true });
    for (const e of plan.evidence) {
      const m = byId.get(e.metricId);
      w.line(`-  ${m?.label ?? e.metricId}: ${m ? formatMetric(m) : e.value}  (${m?.business ?? '?'}, ${m?.period ?? ''})`);
    }
    w.y -= 6;

    if (plan.projections.length) {
      w.line('Projections (arithmetic on the evidence)', { bold: true });
      for (const p of plan.projections) {
        const base = byId.get(p.baseMetricId);
        w.line(`-  ${p.label}: ${base ? formatMetric(base) : p.baseMetricId} x ${p.factor} = ${base?.unit === 'usd' ? money(p.result) : p.result.toLocaleString('en-US')}`);
        w.line(`   assumption: ${p.assumption}`, { size: 9, color: MUTED });
      }
      w.y -= 6;
    }

    if (plan.levers.length) {
      w.line('Choices to approve (proposed, not facts)', { bold: true });
      for (const l of plan.levers) w.line(`-  ${l.label}: ${formatMetric({ value: l.value, unit: l.unit === 'usd' || l.unit === 'percent' || l.unit === 'ratio' ? l.unit : 'count' })}${l.unit === 'days' || l.unit === 'hours' ? ` ${l.unit}` : ''}`);
      w.y -= 6;
    }

    w.line('Test', { bold: true });
    w.line(plan.test, { gap: 6 });
    w.line('Stop-loss', { bold: true });
    w.line(plan.stopLoss, { gap: 6 });
    if (plan.risks.length) {
      w.line('Risks', { bold: true });
      for (const r of plan.risks) w.line(`-  ${r}`);
    }
  }

  w.newPage(footer);
  w.line('How to decide', { size: 16, bold: true, gap: 8 });
  w.line(doc.approvalHint, { gap: 8 });
  if (doc.plans.memoryConflicts.length) {
    w.line('Related past decisions', { bold: true });
    for (const c of doc.plans.memoryConflicts) w.line(`-  ${c.note}`);
  }
  return pdf.save();
}
