import { describe, expect, it } from 'vitest';
import { AssistantId } from '@fahq/contracts';
import { READ_TOOL_NAMES, doorSkill, loadProfiles, profileFromDoor, type DoorTool } from '../src/index.ts';

// What an outside tool is given at a door: the stored profile (checked by the worker's rules) and a skill text
// that names only the tools the door really offers. No database here: the door's answer is built by hand.

const files = loadProfiles({});
const ids = AssistantId.options;
const tool = (name: string): DoorTool => ({ name, description: `door words for ${name}` });
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
/** Every read tool the text names in backticks. */
const named = (text: string) => new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((n) => (READ_TOOL_NAMES as readonly string[]).includes(n)));
const section = (text: string, heading: string) => new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';

/** The answer `door_profile` gives for an assistant: its file profile as a stored row, changed by `over`. */
function doorAnswer(id: AssistantId, over: Record<string, unknown> = {}) {
  const p = files[id];
  return { assistant: id, title: p.title, version: 4, skill: p.skill, reads: [...p.reads], models: p.models, lessons: [], ...over };
}

describe('doorSkill: the skill text a door serves', () => {
  it('lists exactly the tools the door offers, using the profile\'s own line where it has one', () => {
    const text = doorSkill(files.finance, { tools: [tool('recall_my_decisions'), tool('get_finance_metrics')], canReport: true, readNames: READ_TOOL_NAMES });
    const list = section(text, 'You can read').trim().split('\n');
    expect(list).toHaveLength(2);
    expect(list[0]).toBe('- `recall_my_decisions`: what people approved or declined before, from your own memory only.'); // the skill's own line
    expect(list[1]).toMatch(/^- `get_finance_metrics`: salon and online finance metrics for one period, keyed by metric id/);
    expect(named(text)).toEqual(new Set(['recall_my_decisions', 'get_finance_metrics']));
  });

  it('describes a tool in the door\'s words when the skill has no line for it', () => {
    const text = doorSkill(files.online, { tools: [tool('get_timeline')], canReport: true, readNames: READ_TOOL_NAMES });
    expect(section(text, 'You can read').trim()).toBe('- `get_timeline`: door words for get_timeline');
  });

  it('says so when the door offers nothing to read, and still names no read tool', () => {
    for (const id of ids) {
      const text = doorSkill(files[id], { tools: [], canReport: true, readNames: READ_TOOL_NAMES });
      expect(section(text, 'You can read').trim(), id).toBe('Nothing at this door yet: your reads are served inside the worker.');
      expect([...named(text)], id).toEqual([]);
    }
  });

  it('never names a read tool the door lacks, for any profile and any set of door tools', () => {
    const sets = [[], ...READ_TOOL_NAMES.map((n) => [n]), ['get_finance_metrics', 'recall_my_decisions'], [...READ_TOOL_NAMES]];
    for (const id of ids) {
      for (const names of sets) {
        for (const canReport of [true, false]) {
          const text = doorSkill(files[id], { tools: names.map(tool), canReport, readNames: READ_TOOL_NAMES });
          for (const n of named(text)) expect(names, `${id} names ${n}`).toContain(n);
        }
      }
    }
  });

  it('keeps the profile\'s sections in their order, and everything else it says', () => {
    for (const id of ids) {
      const text = doorSkill(files[id], { tools: READ_TOOL_NAMES.map(tool), canReport: true, readNames: READ_TOOL_NAMES });
      expect(headings(text), id).toEqual(headings(files[id].skill));
      expect(text, id).toContain('You are read-only.');
      expect(section(text, 'Numbers'), id).toBe(section(files[id].skill, 'Numbers'));
      expect(text.startsWith(files[id].skill.split('\n')[0]!), id).toBe(true);
    }
  });

  it('leaves out a line elsewhere in the skill that names a tool the door lacks', () => {
    expect(files.finance.skill).toContain('Check `recall_my_decisions` first.');
    const without = doorSkill(files.finance, { tools: [tool('get_finance_metrics')], canReport: true, readNames: READ_TOOL_NAMES });
    expect(without).not.toContain('recall_my_decisions');
    expect(without).not.toContain('Do not repeat an idea a person already declined.');
    expect(without).toContain('People decide by one-time code.'); // the neighbouring lines stay
    const withIt = doorSkill(files.finance, { tools: [tool('recall_my_decisions')], canReport: true, readNames: READ_TOOL_NAMES });
    expect(withIt).toContain('Check `recall_my_decisions` first.');
  });

  it('tells a tool at a door with a report to file one, and one without that it cannot', () => {
    for (const id of ids) {
      const online = doorSkill(files[id], { tools: [], canReport: true, readNames: READ_TOOL_NAMES });
      expect(section(online, 'End of work'), id).toContain('call `file_work_report` once');
      const offline = doorSkill(files[id], { tools: [], canReport: false, readNames: READ_TOOL_NAMES });
      expect(offline, id).not.toContain('file_work_report');
      expect(section(offline, 'End of work').trim(), id).toBe('This door has no database to file a work report in. Put what you did in your reply instead.');
    }
  });

  it('adds the standing lessons as the worker does, leaving out one that names a tool the door lacks', () => {
    const lessons = [
      { text: 'Say the period with every number.', source: 'rec-1', adoptedAt: '2026-10-20T10:00:00Z' },
      { text: 'Always start from `get_online_metrics`.', source: 'rec-2', adoptedAt: '2026-10-21T10:00:00Z' },
    ];
    const text = doorSkill({ skill: files.finance.skill, lessons }, { tools: [tool('get_finance_metrics')], canReport: true, readNames: READ_TOOL_NAMES });
    expect(text).toContain('## Standing lessons');
    expect(text).toContain('- Say the period with every number.');
    expect(text).not.toContain('get_online_metrics');
  });

  it('does not change the profile it is given', () => {
    const before = structuredClone(files.owner);
    doorSkill(files.owner, { tools: [], canReport: false, readNames: READ_TOOL_NAMES });
    expect(files.owner).toEqual(before);
  });
});

describe('profileFromDoor: the stored profile a door serves', () => {
  it('turns the answer into the assistant\'s profile, keeping what the files fix', () => {
    const lessons = [{ text: 'Say the period with every number.', source: 'rec-1', adoptedAt: '2026-10-20T10:00:00Z' }];
    const p = profileFromDoor(doorAnswer('finance', { title: 'Finance Desk', version: 7, reads: ['recall_my_decisions'], lessons }));
    expect(p).toMatchObject({ id: 'finance', title: 'Finance Desk', version: 7, source: 'database', reads: ['recall_my_decisions'], memory: 'finance', serves: 'finance_owner', lessons });
    expect(p.writes).toEqual(files.finance.writes);
    expect(p.skill).toBe(files.finance.skill);
  });

  it('serves each of the five file profiles as stored', () => {
    for (const id of ids) expect(profileFromDoor(doorAnswer(id)), id).toMatchObject({ id, source: 'database', version: 4, reads: [...files[id].reads] });
  });

  it('refuses an answer it cannot read, in plain words', () => {
    expect(() => profileFromDoor(null)).toThrow(/cannot read/);
    expect(() => profileFromDoor({ ...doorAnswer('finance'), skill: undefined })).toThrow(/cannot read.*skill/);
    expect(() => profileFromDoor({ ...doorAnswer('finance'), assistant: 'cindy' })).toThrow(/cannot read.*assistant/);
    expect(() => profileFromDoor(doorAnswer('finance', { version: 0 }))).toThrow(/cannot read/);
  });

  it('refuses a profile that breaks a rule the worker applies too', () => {
    expect(() => profileFromDoor(doorAnswer('finance', { reads: ['send_sms'] }))).toThrow(/finance was refused: it reads "send_sms", which is not a read tool/);
    expect(() => profileFromDoor(doorAnswer('finance', { reads: ['get_finance_metrics', 'get_finance_metrics'] }))).toThrow(/twice/);
    expect(() => profileFromDoor(doorAnswer('salon', { reads: ['get_online_metrics'] }))).toThrow(/salon assistant may never read "get_online_metrics"/);
    expect(() => profileFromDoor(doorAnswer('online', { reads: ['get_salon_metrics'] }))).toThrow(/online assistant may never read "get_salon_metrics"/);
    expect(() => profileFromDoor(doorAnswer('manager', { reads: ['get_finance_metrics'] }))).toThrow(/manager assistant may never read/);
    expect(() => profileFromDoor(doorAnswer('owner', { skill: files.owner.skill.replaceAll('read-only', 'careful') }))).toThrow(/no longer says the assistant is read-only/);
    expect(() => profileFromDoor(doorAnswer('owner', { skill: files.owner.skill.replace('## You never', '## You sometimes') }))).toThrow(/lost the "You never" section/);
    expect(() => profileFromDoor(doorAnswer('owner', { skill: files.owner.skill.replaceAll('read-only', 'RO').replace('## You never', '') }))).toThrow(/refused/);
  });

  it('refuses a model setting that is not a setting, and a lesson without its source', () => {
    expect(() => profileFromDoor(doorAnswer('finance', { models: { plan: { model: 'x', thinking: 'yes', maxTokens: 10, temperature: 0 } } }))).toThrow(/cannot read/);
    expect(() => profileFromDoor(doorAnswer('finance', { lessons: [{ text: 'x', adoptedAt: '2026-10-20T10:00:00Z' }] }))).toThrow(/cannot read/);
  });
});
