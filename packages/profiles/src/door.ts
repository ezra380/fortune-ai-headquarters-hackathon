import { z } from 'zod';
import { AssistantId } from '@fahq/contracts';
import type { AssistantProfile } from './index.ts';
import { ProfileRow, checkProfileRow } from './rows.ts';
import { overlay, skillWithLessons } from './source.ts';

// What an outside AI tool gets at a door: the stored profile of one assistant (as the database hands it over),
// checked by the rules the worker applies, and its skill text rewritten so it names only the tools the door
// really offers. Nothing here imports the rest of the package at run time (index.ts re-exports this file).

/** The answer of `door_profile(token)`: the profile row without the bookkeeping columns. */
export const DoorProfile = ProfileRow.omit({ assistant_id: true, updated_at: true, updated_by: true }).extend({ assistant: AssistantId });
export type DoorProfile = z.infer<typeof DoorProfile>;

/**
 * The profile a door serves: the door's answer on top of the file profile (which keeps the fixed settings:
 * memory, status, who it serves). Throws a plain sentence when the answer is unreadable or breaks a rule the
 * worker enforces too (the business wall, read-only, only real read tools); a door never serves such a profile.
 */
export function doorProfile(raw: unknown, files: Record<AssistantId, AssistantProfile>, readNames: readonly string[]): AssistantProfile {
  const parsed = DoorProfile.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The door gave a profile this tool cannot read (${issue?.path.join('.') || 'profile'}: ${issue?.message ?? 'unreadable'}).`);
  }
  const { assistant, ...row } = parsed.data;
  const reason = checkProfileRow({ assistant_id: assistant, ...row }, readNames);
  if (reason) throw new Error(`The stored profile of ${assistant} was refused: ${reason}. The door will not serve it.`);
  return overlay(files[assistant], row);
}

// ---- The skill a door serves -------------------------------------------------------------------------

export type DoorTool = { name: string; description: string };
export type DoorSkillOptions = {
  /** The read tools this door offers, in the order they should be listed. */
  tools: readonly DoorTool[];
  /** True when the door can file a work report (it has a database to file it in). */
  canReport: boolean;
  /** The fixed list of read tool names: a line naming one the door lacks is left out. */
  readNames: readonly string[];
};

type Section = { heading: string | null; body: string[] };

function sectionsOf(skill: string): Section[] {
  const sections: Section[] = [{ heading: null, body: [] }];
  for (const line of skill.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) sections.push({ heading: heading[1]!, body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  return sections;
}

const trailingBlanks = (lines: readonly string[]) => lines.length - lines.findLastIndex((l) => l.trim() !== '') - 1;

/** True when the line names (in backticks) a read tool that is not on the door. */
function namesAbsentTool(line: string, offered: ReadonlySet<string>, readNames: readonly string[]): boolean {
  return [...line.matchAll(/`([a-z_]+)`/g)].some((m) => readNames.includes(m[1]!) && !offered.has(m[1]!));
}

/**
 * The skill text for a door. The profile's own words, with three changes so it is true at this door:
 *  - "You can read" lists exactly the door's tools (the profile's own line for a tool where it has one);
 *  - a line that names a read tool the door lacks is left out, in any section and in the standing lessons;
 *  - "End of work" says plainly that nothing can be filed when the door has nowhere to file it.
 * Then the profile's standing lessons are added, as the worker does.
 */
export function doorSkill(profile: Pick<AssistantProfile, 'skill' | 'lessons'>, options: DoorSkillOptions): string {
  const offered = new Set(options.tools.map((t) => t.name));
  const keep = (line: string) => !namesAbsentTool(line, offered, options.readNames);
  const out: string[] = [];
  for (const { heading, body } of sectionsOf(profile.skill)) {
    if (heading !== null) out.push(`## ${heading}`);
    const blanks = Array<string>(trailingBlanks(body)).fill('');
    if (heading === 'You can read') {
      const lines = options.tools.map((t) => body.find((l) => l.startsWith(`- \`${t.name}\`:`)) ?? `- \`${t.name}\`: ${t.description}`);
      out.push(...(lines.length > 0 ? lines : ['Nothing at this door yet: your reads are served inside the worker.']), ...blanks);
    } else if (heading === 'End of work' && !options.canReport) {
      out.push('This door has no database to file a work report in. Put what you did in your reply instead.', ...blanks);
    } else {
      out.push(...body.filter(keep));
    }
  }
  const lessons = profile.lessons.filter((l) => keep(l.text));
  return skillWithLessons({ skill: out.join('\n'), lessons });
}
