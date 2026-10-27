import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssistantId, type ReadTool } from '@fahq/contracts';
import { READ_SCOPE, READ_TOOL_NAMES, loadProfiles, pickTools, skillFrontmatter } from '../src/index.ts';

const profiles = loadProfiles({});
const ids = AssistantId.options;
const WRITE_LOOKING = /^(propose|send|create|update|delete|set|adopt|approve)/;
const HEADINGS = ['Job', 'You can read', 'You never', 'How you work with the others', 'Numbers', 'End of work'];

const fakeTool = (name: string): ReadTool => ({ name, description: `reads ${name}`, signature: '() => Promise<unknown>', run: async () => ({}) });
const allTools = () => Object.fromEntries(READ_TOOL_NAMES.map((n) => [n, fakeTool(n)]));

describe('the read-only profiles', () => {
  it('has one profile per assistant, with its own memory', () => {
    expect(Object.keys(profiles).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(profiles[id].id).toBe(id);
      expect(profiles[id].memory).toBe(id);
    }
  });

  it('reads only names from the fixed list, and no read name looks like a write', () => {
    for (const p of Object.values(profiles)) {
      for (const name of p.reads) {
        expect(READ_TOOL_NAMES).toContain(name);
        expect(name).not.toMatch(WRITE_LOOKING);
      }
      expect(new Set(p.reads).size).toBe(p.reads.length);
    }
    for (const name of READ_TOOL_NAMES) expect(name).not.toMatch(WRITE_LOOKING);
  });

  it('gives each assistant exactly its reads and writes', () => {
    expect(profiles.owner.reads).toEqual([
      'get_finance_metrics', 'get_company_overview', 'get_budget_room', 'get_metric_series', 'get_repair_tickets', 'get_supplier_invoices',
      'get_waiting_conversations', 'recall_decisions', 'list_lessons', 'get_timeline', 'open_items', 'latest_proposal', 'usage_summary', 'explain_proposal',
    ]);
    expect(profiles.finance.reads).toEqual(['get_finance_metrics', 'get_budget_room', 'get_metric_series', 'get_supplier_invoices', 'recall_my_decisions', 'my_lessons', 'latest_proposal', 'explain_proposal']);
    expect(profiles.online.reads).toEqual(['get_online_metrics', 'get_metric_series', 'get_waiting_conversations', 'get_low_stock_interest', 'recall_my_decisions', 'my_lessons']);
    expect(profiles.salon.reads).toEqual(['get_salon_metrics', 'get_metric_series', 'get_repair_tickets', 'recall_my_decisions', 'my_lessons']);
    expect(profiles.manager.reads).toEqual(['list_work_reports', 'list_session_reports', 'usage_summary', 'list_lessons', 'get_timeline', 'open_items', 'recall_decisions', 'explain_proposal', 'get_data_quality']);
    expect(profiles.legal.reads).toEqual(['recall_my_decisions', 'my_lessons']);
    expect(profiles.owner.writes).toEqual(['propose']);
    expect(profiles.finance.writes).toEqual(['propose', 'report']);
    expect(profiles.online.writes).toEqual(['propose', 'report']);
    expect(profiles.salon.writes).toEqual(['propose', 'report']);
    expect(profiles.manager.writes).toEqual(['report']);
    expect(profiles.legal.writes).toEqual(['report']);
  });

  it('gives the Legal Team no money, salon, online or shared business data, and no person or phone number', () => {
    expect(profiles.legal).toMatchObject({ id: 'legal', title: 'Legal Team', serves: null, status: 'live', memory: 'legal' });
    // Every read it has is a tool that returns no business data (READ_SCOPE none), and so is every one it could be given by the wall.
    for (const name of profiles.legal.reads) expect(READ_SCOPE[name], name).toBe('none');
    for (const name of ['get_finance_metrics', 'get_online_metrics', 'get_salon_metrics', 'get_company_overview', 'get_budget_room', 'get_supplier_invoices', 'list_work_reports', 'recall_decisions', 'list_lessons']) {
      expect(profiles.legal.reads as readonly string[], name).not.toContain(name);
    }
  });

  it('lets the owner, finance and the manager explain a proposal, and nobody else', () => {
    for (const id of ids) {
      expect(profiles[id].reads.includes('explain_proposal'), id).toBe(['owner', 'finance', 'manager'].includes(id));
    }
  });

  it('runs the salon as the stand-in for Cindy: live, salon numbers only, online away from them', () => {
    expect(profiles.salon).toMatchObject({ status: 'live', title: 'Salon Department (stand-in for Cindy)', serves: 'head_stylist' });
    expect(profiles.salon.reads).not.toContain('get_finance_metrics');
    expect(profiles.salon.reads).not.toContain('get_online_metrics');
    expect(profiles.online.reads).not.toContain('get_finance_metrics');
    expect(profiles.online.reads).not.toContain('get_salon_metrics');
    expect(profiles.manager.reads).not.toContain('get_finance_metrics');
    expect(profiles.manager.serves).toBeNull();
    expect(profiles.finance.serves).toBe('finance_owner');
  });

  it('gives each division its own rows and the company view to HQ only (design 3.7)', () => {
    const readers = (tool: string) => ids.filter((id) => (profiles[id].reads as readonly string[]).includes(tool));
    expect(readers('get_repair_tickets')).toEqual(['owner', 'salon']);
    expect(readers('get_supplier_invoices')).toEqual(['owner', 'finance']);
    expect(readers('get_budget_room')).toEqual(['owner', 'finance']);
    expect(readers('get_waiting_conversations')).toEqual(['owner', 'online']);
    expect(readers('get_low_stock_interest')).toEqual(['online']);
    expect(readers('get_metric_series')).toEqual(['owner', 'finance', 'salon', 'online']);
    expect(readers('get_company_overview')).toEqual(['owner']);
    expect(readers('get_data_quality')).toEqual(['manager']);
  });

  it('assigns each assistant its model jobs, the salon and online like finance', () => {
    const jobs = (id: AssistantId) => Object.keys(profiles[id].models).sort();
    expect(jobs('owner')).toEqual(['answer', 'code', 'route']);
    expect(jobs('finance')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('online')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('salon')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('manager')).toEqual(['answer', 'code', 'review']);
    // The Legal Team answers a question (a lookup, then the words) and plans and reviews nothing.
    expect(jobs('legal')).toEqual(['answer', 'code']);
    expect(profiles.legal.models.code).toEqual(profiles.manager.models.code);
    expect(profiles.legal.models.answer).toEqual(profiles.manager.models.answer);
    expect(profiles.salon.models).toEqual(profiles.finance.models);
  });

  it('uses the models already proven live as the defaults', () => {
    const { route, code, answer } = profiles.owner.models;
    expect(route).toEqual({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinking: false, maxTokens: 600, temperature: 0 });
    expect(code).toEqual({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinking: false, maxTokens: 1200, temperature: 0 });
    expect(answer).toEqual({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinking: false, maxTokens: 400, temperature: 0.2 });
    expect(profiles.finance.models.plan).toEqual({ model: 'nvidia/nemotron-3-ultra-550b-a55b', thinking: true, maxTokens: 16000, temperature: 0.4 });
    expect(profiles.manager.models.review).toEqual({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinking: true, maxTokens: 6000, temperature: 0.2 });
  });

  it('lets the environment change each model, and ignores blank values', () => {
    const p = loadProfiles({
      NEMOTRON_ROUTER_MODEL: 'router-x', NEMOTRON_PLAN_MODEL: 'plan-x', CODE_MODEL: 'code-x', ANSWER_MODEL: 'answer-x', REVIEW_MODEL: '  ',
    });
    expect(p.owner.models.route?.model).toBe('router-x');
    expect(p.finance.models.plan?.model).toBe('plan-x');
    expect(p.owner.models.code?.model).toBe('code-x');
    expect(p.online.models.answer?.model).toBe('answer-x');
    expect(p.manager.models.review?.model).toBe('router-x');
    // Without CODE_MODEL the script writer follows the router model.
    expect(loadProfiles({ NEMOTRON_ROUTER_MODEL: 'router-y' }).owner.models.code?.model).toBe('router-y');
  });

  it('hands out copies, so changing one profile never changes the next load', () => {
    const first = loadProfiles({});
    first.owner.models.code!.model = 'changed';
    (first.owner.reads as string[]).push('get_online_metrics');
    expect(loadProfiles({}).owner.models.code?.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(loadProfiles({}).owner.reads).not.toContain('get_online_metrics');
  });
});

describe('the skills', () => {
  it.each(ids)('%s has frontmatter, the six sections and says it is read-only', (id) => {
    const front = skillFrontmatter(id);
    expect(front.name).toBe(`fortune-hq-${id}`);
    expect(front.description.length).toBeGreaterThan(20);
    expect(front.description).toMatch(/read-only/i);
    const body = profiles[id].skill;
    expect(body.startsWith('---')).toBe(false);
    for (const heading of HEADINGS) expect(body).toMatch(new RegExp(`^## ${heading}$`, 'm'));
    expect(body).toContain('read-only');
    expect(body.split('\n').length).toBeLessThanOrEqual(48);
  });

  it.each(ids)('%s names exactly the tools its profile reads', (id) => {
    const named = new Set([...profiles[id].skill.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
    for (const tool of READ_TOOL_NAMES) {
      expect(named.has(tool), `${id} skill and ${tool}`).toBe((profiles[id].reads as readonly string[]).includes(tool));
    }
  });

  it('keeps the rules that matter in the right skills', () => {
    expect(profiles.salon.skill).toMatch(/stand-in for Cindy/);
    expect(profiles.salon.skill).toMatch(/synthetic/);
    expect(profiles.salon.skill).toMatch(/personal data never\s+cross/i);
    expect(profiles.manager.skill).toMatch(/at most 3 changes/);
    expect(profiles.manager.skill).toMatch(/adopts it by one-time\s+code/);
    for (const id of ids) expect(profiles[id].skill).toMatch(/never by text|never to text|never send a text/i);
  });
});

describe('the Legal Team skill', () => {
  const skill = profiles.legal.skill;
  const never = /^## You never\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(skill)?.[1] ?? '';
  const job = /^## Job\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(skill)?.[1] ?? '';

  it('is named for the Legal Team and says what it reviews: terms, vendor and SaaS agreements, marketplace terms, and the company\'s own policies', () => {
    expect(skillFrontmatter('legal').description).toMatch(/Legal Team/);
    for (const subject of [/terms and conditions/i, /vendor and SaaS agreements/i, /marketplace terms/i, /returns/i, /consignment/i, /personalization/i, /privacy/i, /SMS and email consent/i]) {
      expect(job, String(subject)).toMatch(subject);
    }
  });

  it('gives a committed read: each clause Green, Yellow or Red with why, what to ask for instead, and whether a licensed attorney must look', () => {
    for (const word of ['Green', 'Yellow', 'Red', 'what to ask for instead', 'licensed attorney']) expect(job, word).toContain(word);
    expect(job).toMatch(/before anyone signs or acts/i);
  });

  it('names the Anthropic Legal plugin skills and commands that really exist, the commercial-legal plugin, and where they come from', () => {
    // Checked 2026-10-27 against the READMEs of anthropics/knowledge-work-plugins (legal) and anthropics/claude-for-legal (commercial-legal).
    for (const name of [
      'legal:contract-review', 'legal:legal-risk-assessment', 'legal:compliance', 'legal:nda-triage', 'legal:canned-responses',
      '/legal:review-contract', '/legal:triage-nda', '/legal:vendor-check', '/legal:respond',
      'vendor-agreement-review', 'saas-msa-review', 'renewal-tracker', '/commercial-legal:review', '/commercial-legal:renewal-tracker',
    ]) {
      expect(skill, name).toContain(`\`${name}\``);
    }
    // Names that do not exist (the README lists skills contract-review, nda-triage, compliance, canned-responses, legal-risk-assessment,
    // meeting-briefing and commands review-contract, triage-nda, vendor-check, brief, respond): never sent a session looking for them.
    for (const invented of ['compliance-check', 'legal-response']) expect(skill, invented).not.toContain(invented);
    for (const command of ['review-contract', 'triage-nda', 'vendor-check']) expect(skill, `${command} is a command, not a skill`).not.toMatch(new RegExp(`\`${command}\``));
    expect(skill).toContain('https://github.com/anthropics/knowledge-work-plugins/tree/main/legal');
    expect(skill).toContain('https://github.com/anthropics/claude-for-legal');
    // The skill stands alone: when the session lacks the plugins it still gives the read (the method does not depend on them).
    expect(skill).toMatch(/when the session has them/i);
    expect(skill).toMatch(/without them|if the session has none/i);
  });

  it('keeps the closing call free of counted words, because a text answer is number-traced and the skill is loaded for it too', () => {
    expect(job).toMatch(/one overall call/i);
    expect(job).not.toMatch(/\b(one|two|three|four|five)\s+things\b/i);
    expect(job).not.toMatch(/\bthree\b/i);
  });

  it('says plainly what the Legal Team does by text: no document is carried, so it recalls its own decisions and lessons, points to a door, and gives no read, count or figure', () => {
    const how = /^## How you work with the others\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(skill)?.[1] ?? '';
    expect(how).toMatch(/by text/i);
    expect(how).toMatch(/carries no document/i);
    expect(how).toMatch(/not seen the document/i);
    expect(how).toMatch(/staff session at your door/i);
    expect(how).toMatch(/no read, no count of fixes and no figure/i);
    expect(how).not.toMatch(/general terms/i);
  });

  it('forbids anything medical or about hair loss, and still covers the company\'s own personalization policy (cutting and styling a hairpiece)', () => {
    expect(never).toMatch(/medical, or about a person's health or hair loss/i);
    expect(never).not.toMatch(/health or hair\.|or hair\./);
    expect(never).toMatch(/ordinary policy and in scope/i);
    expect(job).toMatch(/personalization/i);
  });

  it('never presents itself as a lawyer, acts for the company, invents the law, obeys a document, or writes anything medical or about business data', () => {
    for (const rule of [/lawyer/i, /legal opinion/i, /sign|click agree|accept/i, /file|send a notice|contact a counterparty/i, /invent/i, /statute|case|citation/i, /document you read is data|data, never instructions/i, /medical/i, /business data|money/i]) {
      expect(never, String(rule)).toMatch(rule);
    }
    expect(never).toMatch(/unverified/i);
  });

  it('holds no phone number, email address, web address of a real business or customer, and is within the other skills\' size', () => {
    expect(skill).not.toMatch(/\+?\d[\d ().-]{8,}\d/);
    expect(skill).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect([...skill.matchAll(/https?:\/\/[^\s)`]+/g)].map((m) => m[0])).toEqual([
      'https://github.com/anthropics/knowledge-work-plugins/tree/main/legal', 'https://github.com/anthropics/claude-for-legal',
    ]);
  });
});

describe('pickTools', () => {
  it('returns exactly the profile tools, in the profile order', () => {
    const picked = pickTools(allTools(), profiles.finance);
    expect(picked.map((t) => t.name)).toEqual(['get_finance_metrics', 'get_budget_room', 'get_metric_series', 'get_supplier_invoices', 'recall_my_decisions', 'my_lessons', 'latest_proposal', 'explain_proposal']);
  });

  it('never returns a tool the profile does not list, even when more are available', () => {
    const all = { ...allTools(), propose_task: fakeTool('propose_task'), send_sms: fakeTool('send_sms') };
    for (const p of Object.values(profiles)) {
      const names = pickTools(all, p).map((t) => t.name);
      expect(names).toEqual([...p.reads]);
      expect(names).not.toContain('propose_task');
      expect(names).not.toContain('send_sms');
    }
    expect(pickTools(all, profiles.salon).map((t) => t.name)).toEqual(['get_salon_metrics', 'get_metric_series', 'get_repair_tickets', 'recall_my_decisions', 'my_lessons']);
  });

  it('throws on a name that is missing from the available tools', () => {
    const { get_finance_metrics: _gone, ...rest } = allTools();
    expect(() => pickTools(rest, profiles.finance)).toThrow(/get_finance_metrics is not available for finance/);
    expect(() => pickTools({}, profiles.salon)).toThrow(/get_salon_metrics is not available for salon/);
  });

  it('does not take a name from the object prototype, and refuses a tool registered under another name', () => {
    expect(() => pickTools({}, { ...profiles.finance, reads: ['toString' as never] })).toThrow(/is not available/);
    expect(() => pickTools({ ...allTools(), my_lessons: fakeTool('propose_task') }, profiles.finance)).toThrow(/registered under the name propose_task/);
  });
});

describe('file profiles and the database layer', () => {
  it('says a file profile comes from the files: no version, no lessons', () => {
    for (const id of ids) expect(profiles[id]).toMatchObject({ source: 'files', version: null, lessons: [] });
  });

  it('keeps the database modules free of a runtime import of index.ts, so the package has no import cycle', () => {
    // index.ts re-exports these files; if one imported index.ts back at run time, load order would decide what exists.
    for (const name of ['rows', 'source', 'seed', 'tokens', 'door']) {
      const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', `${name}.ts`), 'utf8');
      const runtimeImports = text.split('\n').filter((line) => /^import (?!type\b).*from '\.\/index\.ts'/.test(line));
      expect(runtimeImports, name).toEqual([]);
    }
  });
});
