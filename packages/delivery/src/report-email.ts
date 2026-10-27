import type { ReportContext, ReportEmail, ReportStatus, WeeklyReport, WorkerReport } from '@fahq/contracts';
import { formatValue, longDate, WORKER_LABEL } from './format.ts';
import { scrub } from './scrub.ts';

// The email that carries a report's PDF. Built from the stored report (never from the outbox text, which may carry
// a one-time code), with every word escaped for HTML and scrubbed of phone numbers, addresses and codes. The email
// is the short version; the PDF has the detail. Brand kit colors, Georgia and Arial standing in for its typefaces.

const STATUS_WORDS: Record<ReportStatus, string> = { normal: 'On track', watch: 'Worth a look', act: 'Needs action' };
const NOTE = "Sent to the owner's address only while the data is synthetic. Replying to this email does nothing: choose by text, with the one-time code on your phone.";

const esc = (text: string) => scrub(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ranks = (n: readonly number[]) => (n.length < 2 ? `${n[0]}` : `${n.slice(0, -1).join(', ')} or ${n.at(-1)}`);

type Block = { heading?: string; lines: readonly string[]; lead?: string };

/** The same blocks make the text and the HTML, so the two never say different things. */
function render(opts: { preheader: string; title: string; byline: string; status: ReportStatus; blocks: readonly Block[]; attached: string }): { html: string; text: string } {
  const text = [
    opts.title, opts.byline, `Status: ${STATUS_WORDS[opts.status]}`, '',
    ...opts.blocks.flatMap((b) => [...(b.heading ? [b.heading.toUpperCase()] : []), ...(b.lead ? [b.lead] : []), ...b.lines, '']),
    opts.attached, '', NOTE,
  ].map(scrub).join('\n');

  const p = (s: string, style = '') => `<p style="margin:0 0 10px;font-size:15px;line-height:22px;${style}">${esc(s)}</p>`;
  const body = opts.blocks.map((b) => [
    b.heading ? `<h2 style="margin:22px 0 8px;font-family:'Playfair Display',Georgia,serif;font-size:18px;line-height:24px;font-weight:700;color:#212424;border-bottom:1px solid #DADADA;padding-bottom:6px;">${esc(b.heading)}</h2>` : '',
    b.lead ? p(b.lead, 'color:#5B5F60;font-size:13px;') : '',
    ...b.lines.map((l) => p(l)),
  ].join('')).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#F0F1F3;font-family:Lato,Helvetica,Arial,sans-serif;color:#212424;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F0F1F3;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#FFFFFF;">
<tr><td style="height:6px;background:#5699A9;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px;">
<div style="font-size:12px;letter-spacing:1px;color:#5B5F60;">FORTUNE AI HEADQUARTERS &middot; SYNTHETIC DATA</div>
<h1 style="margin:8px 0 4px;font-family:'Playfair Display',Georgia,serif;font-size:28px;line-height:34px;font-weight:700;color:#212424;">${esc(opts.title)}</h1>
<div style="font-size:14px;color:#5B5F60;">${esc(opts.byline)}</div>
<div style="margin:14px 0 4px;"><span style="display:inline-block;padding:4px 10px;font-size:12px;font-weight:700;letter-spacing:1px;background:${opts.status === 'act' ? '#212424' : opts.status === 'watch' ? '#CCE0E5' : '#D6E1E2'};color:${opts.status === 'act' ? '#FFFFFF' : '#212424'};">${esc(STATUS_WORDS[opts.status].toUpperCase())}</span></div>
${body}
<div style="margin:24px 0 0;padding:12px 14px;background:#CCE0E5;font-size:14px;line-height:21px;color:#212424;">${esc(opts.attached)}</div>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;line-height:18px;color:#5B5F60;">${esc(NOTE)}</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text };
}

export function buildWeeklyEmail(weekly: WeeklyReport, ctx: ReportContext): ReportEmail {
  const metrics = new Map(weekly.metrics.map((m) => [m.id, m]));
  const blocks: Block[] = [{ heading: 'Summary', lines: [weekly.summary] }];
  if (weekly.goal) {
    const goal = weekly.goal;
    const metric = metrics.get(goal.metricId);
    const at = (value: number) => (metric ? formatValue({ id: metric.id, unit: metric.unit, value }) : String(value));
    blocks.push({ heading: 'Goal of the week', lines: [goal.title, `${metric?.label ?? goal.metricId}: from ${at(goal.from)} to ${at(goal.to)} by ${longDate(goal.by)}.`] });
  }
  if (weekly.paths) {
    const plans = [...weekly.paths.plans].sort((a, b) => a.rank - b.rank);
    blocks.push({ heading: 'Three paths', lead: `To choose one, reply APPROVE ${ranks(plans.map((p) => p.rank))} by text with the one-time code on your phone.`, lines: plans.map((p) => `${p.rank}. ${p.title}: ${p.summary}`) });
  }
  if (weekly.actions.length) {
    const actions = [...weekly.actions].sort((a, b) => a.rank - b.rank);
    blocks.push({ heading: 'Actions for you', lead: `To approve one, reply APPROVE ${ranks(actions.map((a) => a.rank))} by text with the one-time code on your phone.`, lines: actions.map((a) => `${a.rank}. ${a.title}: ${a.why}`) });
  }
  blocks.push({ heading: 'By area', lines: weekly.sections.map((s) => `${WORKER_LABEL[s.workerId]} (${STATUS_WORDS[s.status].toLowerCase()}): ${s.summary}`) });
  const title = `${ctx.divisionTitle} weekly report`;
  const { html, text } = render({
    preheader: weekly.summary, title, byline: `For ${ctx.head}  |  ${ctx.manager}'s report  |  week of ${longDate(weekly.weekOf)}`,
    status: weekly.status, blocks, attached: 'The full report is attached as a PDF: the summary and what to decide first, then one page for each worker.',
  });
  return { subject: `For ${ctx.head}: ${ctx.manager}'s weekly report`, html, text, attachmentName: `${ctx.divisionTitle}-weekly-report-${weekly.weekOf}.pdf` };
}

export function buildWorkerEmail(report: WorkerReport, ctx: ReportContext): ReportEmail {
  const metrics = new Map(report.metrics.map((m) => [m.id, m]));
  const cited = (cites: readonly string[]) => [...new Set(cites)].map((id) => { const m = metrics.get(id); return m ? `${m.label} ${formatValue(m)}` : id; }).join('; ');
  const blocks: Block[] = [
    { heading: 'Headline', lines: [report.headline] },
    ...(report.findings.length ? [{ heading: 'What the worker found', lines: report.findings.map((f, i) => `${i + 1}. ${f.text}${f.cites.length ? ` (${cited(f.cites)})` : ''}`) }] : []),
    ...(report.attention.length ? [{ heading: 'Rules that fired', lines: report.attention.map((a) => `${a.level === 'act' ? 'Needs action' : 'Worth a look'}: ${a.rule}`) }] : []),
  ];
  const label = WORKER_LABEL[report.workerId];
  const { html, text } = render({
    preheader: report.headline, title: `${label} daily report`, byline: `For ${ctx.head}  |  ${ctx.divisionTitle}  |  ${longDate(report.day)}`,
    status: report.status, blocks, attached: 'The full report, with its numbers and where they come from, is attached as a PDF.',
  });
  return { subject: `For ${ctx.head}: ${label} daily report`, html, text, attachmentName: `${ctx.divisionTitle}-${report.workerId.split('.')[1]}-${report.day}.pdf` };
}
