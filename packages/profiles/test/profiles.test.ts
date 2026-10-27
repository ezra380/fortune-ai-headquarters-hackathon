import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssistantId, type ReadTool } from '@fahq/contracts';
import { READ_TOOL_NAMES, loadProfiles, pickTools, skillFrontmatter } from '../src/index.ts';

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
    expect(profiles.owner.reads).toEqual(['get_finance_metrics', 'recall_decisions', 'list_lessons', 'get_timeline', 'open_items', 'latest_proposal', 'usage_summary', 'explain_proposal']);
    expect(profiles.finance.reads).toEqual(['get_finance_metrics', 'recall_my_decisions', 'my_lessons', 'latest_proposal', 'explain_proposal']);
    expect(profiles.online.reads).toEqual(['get_online_metrics', 'recall_my_decisions', 'my_lessons']);
    expect(profiles.salon.reads).toEqual(['get_salon_metrics', 'recall_my_decisions', 'my_lessons']);
    expect(profiles.manager.reads).toEqual(['list_work_reports', 'usage_summary', 'list_lessons', 'get_timeline', 'open_items', 'recall_decisions', 'explain_proposal']);
    expect(profiles.owner.writes).toEqual(['propose']);
    expect(profiles.finance.writes).toEqual(['propose', 'report']);
    expect(profiles.online.writes).toEqual(['propose', 'report']);
    expect(profiles.salon.writes).toEqual(['propose', 'report']);
    expect(profiles.manager.writes).toEqual(['report']);
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

  it('assigns each assistant its model jobs, the salon and online like finance', () => {
    const jobs = (id: AssistantId) => Object.keys(profiles[id].models).sort();
    expect(jobs('owner')).toEqual(['answer', 'code', 'route']);
    expect(jobs('finance')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('online')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('salon')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('manager')).toEqual(['answer', 'code', 'review']);
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

describe('pickTools', () => {
  it('returns exactly the profile tools, in the profile order', () => {
    const picked = pickTools(allTools(), profiles.finance);
    expect(picked.map((t) => t.name)).toEqual(['get_finance_metrics', 'recall_my_decisions', 'my_lessons', 'latest_proposal', 'explain_proposal']);
  });

  it('never returns a tool the profile does not list, even when more are available', () => {
    const all = { ...allTools(), propose_task: fakeTool('propose_task'), send_sms: fakeTool('send_sms') };
    for (const p of Object.values(profiles)) {
      const names = pickTools(all, p).map((t) => t.name);
      expect(names).toEqual([...p.reads]);
      expect(names).not.toContain('propose_task');
      expect(names).not.toContain('send_sms');
    }
    expect(pickTools(all, profiles.salon).map((t) => t.name)).toEqual(['get_salon_metrics', 'recall_my_decisions', 'my_lessons']);
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
