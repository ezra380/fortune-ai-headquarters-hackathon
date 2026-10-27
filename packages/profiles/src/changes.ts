import type { ChangeKind, ModelChange, ReadsChange } from '@fahq/contracts';
import { checkProfileRow, type ProfileLesson, type ProfileRow } from './rows.ts';

// The changes the HQ Manager may make to a profile, as pure functions: a typed change in, the next profile (or a
// plain reason it was refused) out. Nothing here reads or writes the database; the worker does that around it.
//  - lesson     adds one standing lesson to the profile's lessons;
//  - skill_note adds one line to the "Notes from the HQ Manager" section at the end of the skill;
//  - reads      adds or removes read tools; the same checks as for any stored profile still hold afterwards;
//  - model      moves one job to a model another job already uses.
// A lesson or a note is one short line of plain text, checked here before it is ever stored (see checkChangeText).

export type ProfileChange =
  | { kind: 'lesson'; text: string }
  | { kind: 'skill_note'; text: string }
  | { kind: 'reads'; add: readonly string[]; remove: readonly string[] }
  | { kind: 'model'; job: ModelChange['job']; model: string };

/** The part of a profile a change can touch. */
export type ProfileContent = Pick<ProfileRow, 'assistant_id' | 'title' | 'skill' | 'reads' | 'models' | 'lessons'>;

export type ChangeOptions = {
  /** The fixed list of read tools. */
  readNames: readonly string[];
  /** The models some job uses today: a model change may only move a job to one of them. */
  knownModels: readonly string[];
  /** What the change came from (the recommendation's id). A lesson with this source is never added twice. */
  source: string;
  now: Date;
};

export type AppliedChange =
  | { ok: true; changed: boolean; next: Omit<ProfileContent, 'assistant_id'>; dropped: string[] }
  | { ok: false; reason: string };

export const MANAGER_NOTES_HEADING = 'Notes from the HQ Manager';
/** The newest notes kept in the skill; older ones stay in the version history. */
export const MAX_MANAGER_NOTES = 12;
/** The table holds at most this many lessons (the newest); older ones stay in the version history. */
export const MAX_LESSONS = 50;
const MAX_SKILL_CHARS = 12_000;

// ---- The notes section of a skill ----------------------------------------------------------------------

const NOTES_HEADING_LINE = `## ${MANAGER_NOTES_HEADING}`;

/** The notes in a skill's "Notes from the HQ Manager" section, oldest first. */
export function managerNotes(skill: string): string[] {
  const lines = skill.split('\n');
  const start = lines.indexOf(NOTES_HEADING_LINE);
  if (start < 0) return [];
  const notes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const note = /^- (.+)$/.exec(line)?.[1]?.trim();
    if (note) notes.push(note);
  }
  return notes;
}

/** The skill with its notes section replaced by these notes (at the end; no section at all when there are none). */
export function withManagerNotes(skill: string, notes: readonly string[]): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of skill.split('\n')) {
    if (line === NOTES_HEADING_LINE) inside = true;
    else if (line.startsWith('## ')) inside = false;
    if (!inside) kept.push(line);
  }
  const base = kept.join('\n').trimEnd();
  return notes.length === 0 ? base : `${base}\n\n${NOTES_HEADING_LINE}\n${notes.map((n) => `- ${n}`).join('\n')}`;
}

// ---- The text of a lesson or a note ---------------------------------------------------------------------

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that would turn a line of advice into an order or a way around the rules, or bring in what must never be
// stored. This is a net, not a proof: what keeps the rest safe is that a lesson or a note is one short line that can
// be added and nothing more, that it is shown to the owner, and that every version can be put back.
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  // The same shapes the database masks in a session report (redact_text): a phone number, a ten-digit run, a six-digit code.
  [/\+\d[\d ().-]{7,18}\d|(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)|(?<!\d)1?\d{10}(?!\d)|(?<![\d.,$])\d{6}(?!\d)(?!\.\d)/, 'it holds a phone number or a code'],
  [/\b(hair[- ]?loss|alopecia|chemo(therapy)?|cancer|medical|diagnos\w*|patients?)\b/i, 'it touches medical or hair-loss data, which is never stored'],
  [/\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(rules?|instructions?|limits?|safety|screen|previous|above|approval)s?\b/i, 'it tries to get around the rules'],
  [/\b(without|bypassing|skipping)\b.{0,20}\b(one-?time )?(code|approval)\b/i, 'it tries to do without a person\'s code'],
  [/\bplain\s*["'“]?(yes|ok)\b/i, 'it treats a plain "yes" as a decision'],
  [/\b(no longer|stop being|not) read-?only\b/i, 'it says the assistant is not read-only'],
  [/\b(you|assistants?)\b.{0,20}\b(may|can|should|must)\b.{0,12}\b(now )?(send|charge|publish|approve|change an ad|message a customer)\b/i, 'it gives the assistant a power it does not have'],
  [/\b(system prompt|developer message|jailbreak)\b/i, 'it talks about the prompt itself'],
  [/https?:\/\/|www\./i, 'it holds a web address'],
];

/**
 * A plain reason a lesson or a note is not accepted, or null. It must be one short line of plain words, hold no
 * phone number or code and nothing medical, not try to get around the rules, and not tell the assistant to use a
 * read tool it may not read (`reads` is what it may read).
 */
export function checkChangeText(text: string, reads: readonly string[], readNames: readonly string[]): string | null {
  if (text.trim().length === 0) return 'it is empty';
  if (text.length > 300) return 'it is longer than 300 characters';
  if (/[\r\n]/.test(text)) return 'it is not one line';
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(text)) return reason;
  const tool = readNames.find((name) => !reads.includes(name) && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text));
  return tool ? `it tells the assistant to use "${tool}", which it may not read` : null;
}

// ---- Applying a change ----------------------------------------------------------------------------------

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** The change as the recommendation table stores and the owner reads it. At most 300 characters. */
export function describeChange(change: ProfileChange): string {
  switch (change.kind) {
    case 'lesson':
    case 'skill_note':
      return change.text;
    case 'reads': {
      const parts = [change.add.length > 0 ? `add ${change.add.join(', ')}` : '', change.remove.length > 0 ? `remove ${change.remove.join(', ')}` : ''];
      return clip(`Read tools: ${parts.filter(Boolean).join('; ')}`, 300);
    }
    case 'model':
      return clip(`Model for ${change.job}: ${change.model}`, 300);
  }
}

/** How the owner's text names a kind, e.g. "lesson" before the words of a lesson. */
export const KIND_LABEL: Record<ChangeKind, string> = { lesson: 'lesson', skill_note: 'skill note', reads: 'data access', model: 'model' };

/** The typed change a stored or written recommendation stands for. */
export function changeOf(rec: { kind: ChangeKind; change: string; reads?: Partial<ReadsChange> | undefined; model?: ModelChange | undefined }): ProfileChange {
  switch (rec.kind) {
    case 'reads':
      return { kind: 'reads', add: rec.reads?.add ?? [], remove: rec.reads?.remove ?? [] };
    case 'model':
      if (!rec.model) throw new Error('a model change needs the job and the model');
      return { kind: 'model', job: rec.model.job, model: rec.model.model };
    default:
      return { kind: rec.kind, text: rec.change };
  }
}

function applyReads(row: ProfileContent, change: Extract<ProfileChange, { kind: 'reads' }>, options: ChangeOptions): AppliedChange {
  const unknown = [...change.add, ...change.remove].find((name) => !options.readNames.includes(name));
  if (unknown) return { ok: false, reason: `"${unknown}" is not a read tool` };
  const next = [...row.reads.filter((name) => !change.remove.includes(name)), ...change.add.filter((name) => !row.reads.includes(name))];
  const same = next.length === row.reads.length && next.every((name, i) => name === row.reads[i]);
  if (next.length === 0) return { ok: false, reason: 'that would leave the assistant with nothing to read' };
  return { ok: true, changed: !same, next: { title: row.title, skill: row.skill, reads: next, models: row.models, lessons: row.lessons }, dropped: [] };
}

function applyModel(row: ProfileContent, change: Extract<ProfileChange, { kind: 'model' }>, options: ChangeOptions): AppliedChange {
  const current = row.models[change.job];
  if (!current) return { ok: false, reason: `the ${row.assistant_id} assistant has no model for "${change.job}"` };
  if (!options.knownModels.includes(change.model)) return { ok: false, reason: `"${change.model}" is not a model any job uses today` };
  const models = { ...row.models, [change.job]: { ...current, model: change.model } };
  return { ok: true, changed: current.model !== change.model, next: { title: row.title, skill: row.skill, reads: row.reads, models, lessons: row.lessons }, dropped: [] };
}

function applyLesson(row: ProfileContent, text: string, options: ChangeOptions): AppliedChange {
  const same = row.lessons.some((l) => l.source === options.source || normalized(l.text) === normalized(text));
  if (same) return { ok: true, changed: false, next: { title: row.title, skill: row.skill, reads: row.reads, models: row.models, lessons: row.lessons }, dropped: [] };
  const lesson: ProfileLesson = { text, source: options.source.slice(0, 100), adoptedAt: options.now.toISOString() };
  const all = [...row.lessons, lesson];
  const dropped = all.slice(0, Math.max(0, all.length - MAX_LESSONS)).map((l) => l.text);
  return { ok: true, changed: true, next: { title: row.title, skill: row.skill, reads: row.reads, models: row.models, lessons: all.slice(dropped.length) }, dropped };
}

function applyNote(row: ProfileContent, text: string): AppliedChange {
  const notes = managerNotes(row.skill);
  if (notes.some((n) => normalized(n) === normalized(text))) {
    return { ok: true, changed: false, next: { title: row.title, skill: row.skill, reads: row.reads, models: row.models, lessons: row.lessons }, dropped: [] };
  }
  const all = [...notes, text.trim()];
  const dropped = all.slice(0, Math.max(0, all.length - MAX_MANAGER_NOTES));
  const skill = withManagerNotes(row.skill, all.slice(dropped.length));
  if (skill.length > MAX_SKILL_CHARS) return { ok: false, reason: 'the skill would be longer than 12000 characters' };
  return { ok: true, changed: true, next: { title: row.title, skill, reads: row.reads, models: row.models, lessons: row.lessons }, dropped };
}

/**
 * The profile after one change, or the plain reason it is refused. `changed` is false when the profile already says
 * this (the same lesson, note, read tools or model): nothing needs writing then. Whatever the change, the result is
 * checked with the same rules as any stored profile (real read tools, the business wall, read-only, "You never").
 */
export function applyProfileChange(row: ProfileContent, change: ProfileChange, options: ChangeOptions): AppliedChange {
  let applied: AppliedChange;
  if (change.kind === 'reads') applied = applyReads(row, change, options);
  else if (change.kind === 'model') applied = applyModel(row, change, options);
  else {
    const refusal = checkChangeText(change.text, row.reads, options.readNames);
    if (refusal) return { ok: false, reason: `the ${change.kind === 'lesson' ? 'lesson' : 'note'} was not accepted: ${refusal}` };
    applied = change.kind === 'lesson' ? applyLesson(row, change.text, options) : applyNote(row, change.text);
  }
  if (!applied.ok) return applied;
  const rule = checkProfileRow({ assistant_id: row.assistant_id, reads: applied.next.reads, skill: applied.next.skill }, options.readNames);
  return rule ? { ok: false, reason: rule } : applied;
}
