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
    expect(profiles.owner.reads).toEqual(['get_finance_metrics', 'recall_decisions', 'list_lessons', 'get_timeline', 'open_items', 'latest_proposal', 'usage_summary']);
    expect(profiles.finance.reads).toEqual(['get_finance_metrics', 'recall_my_decisions', 'my_lessons', 'latest_proposal']);
    expect(profiles.online.reads).toEqual(['get_online_metrics', 'recall_my_decisions', 'my_lessons']);
    expect(profiles.manager.reads).toEqual(['list_work_reports', 'usage_summary', 'list_lessons', 'get_timeline', 'open_items', 'recall_decisions']);
    expect(profiles.owner.writes).toEqual(['propose']);
    expect(profiles.finance.writes).toEqual(['propose', 'report']);
    expect(profiles.online.writes).toEqual(['report']);
    expect(profiles.salon.writes).toEqual([]);
    expect(profiles.manager.writes).toEqual(['report']);
  });

  it('keeps salon a placeholder that reads nothing, and online away from salon numbers', () => {
    expect(profiles.salon.status).toBe('placeholder');
    expect(profiles.salon.reads).toEqual([]);
    expect(profiles.salon.models).toEqual({});
    expect(profiles.online.reads).not.toContain('get_finance_metrics');
    expect(profiles.manager.reads).not.toContain('get_finance_metrics');
    expect(profiles.manager.serves).toBeNull();
    expect(profiles.finance.serves).toBe('finance_owner');
  });

  it('assigns each assistant its model jobs', () => {
    const jobs = (id: AssistantId) => Object.keys(profiles[id].models).sort();
    expect(jobs('owner')).toEqual(['answer', 'code', 'route']);
    expect(jobs('finance')).toEqual(['answer', 'code', 'plan']);
    expect(jobs('online')).toEqual(['answer', 'code']);
    expect(jobs('salon')).toEqual([]);
    expect(jobs('manager')).toEqual(['code', 'review']);
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
    expect(profiles.salon.skill).toMatch(/placeholder/i);
    expect(profiles.salon.skill).toMatch(/Cindy/);
    expect(profiles.salon.skill).toMatch(/personal data never\s+cross/i);
    expect(profiles.manager.skill).toMatch(/at most 3 changes/);
    expect(profiles.manager.skill).toMatch(/adopts it by one-time\s+code/);
    for (const id of ids) expect(profiles[id].skill).toMatch(/never by text|never to text|never send a text/i);
  });
});

describe('pickTools', () => {
  it('returns exactly the profile tools, in the profile order', () => {
    const picked = pickTools(allTools(), profiles.finance);
    expect(picked.map((t) => t.name)).toEqual(['get_finance_metrics', 'recall_my_decisions', 'my_lessons', 'latest_proposal']);
  });

  it('never returns a tool the profile does not list, even when more are available', () => {
    const all = { ...allTools(), propose_task: fakeTool('propose_task'), send_sms: fakeTool('send_sms') };
    for (const p of Object.values(profiles)) {
      const names = pickTools(all, p).map((t) => t.name);
      expect(names).toEqual([...p.reads]);
      expect(names).not.toContain('propose_task');
      expect(names).not.toContain('send_sms');
    }
    expect(pickTools(all, profiles.salon)).toEqual([]);
  });

  it('throws on a name that is missing from the available tools', () => {
    const { get_finance_metrics: _gone, ...rest } = allTools();
    expect(() => pickTools(rest, profiles.finance)).toThrow(/get_finance_metrics is not available for finance/);
    expect(() => pickTools({}, profiles.salon)).not.toThrow();
  });

  it('does not take a name from the object prototype, and refuses a tool registered under another name', () => {
    expect(() => pickTools({}, { ...profiles.finance, reads: ['toString' as never] })).toThrow(/is not available/);
    expect(() => pickTools({ ...allTools(), my_lessons: fakeTool('propose_task') }, profiles.finance)).toThrow(/registered under the name propose_task/);
  });
});
