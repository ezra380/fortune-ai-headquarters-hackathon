import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AssistantId, type ReadTool } from '@fahq/contracts';
import type { ProfileLesson } from './rows.ts';
import { buildProfileSource, type ProfileSource, type ProfileSourceOptions } from './source.ts';
import { doorProfile } from './door.ts';
import { restoreVersion, type RestoreResult } from './restore.ts';
import { seedFromFiles, type Queryable, type SeedResult } from './seed.ts';

// The assistants as data. Every assistant is read-only: its reads are a fixed list of tool names, and
// proposals and work reports are fixed worker code paths that no model can call. A profile also says
// which model does which job and where the assistant's own memory lives. The skill text is the same
// rules in every way in: the Code Mode system prompt in the worker and the `skill` prompt of the MCP door.

export type ModelJob = 'route' | 'code' | 'answer' | 'plan' | 'review';
export type ModelSetting = { model: string; thinking: boolean; maxTokens: number; temperature: number };

/** Every function an assistant can ever be given. None of them changes anything. Each declares whose data it returns (READ_SCOPE in rows.ts). */
export const READ_TOOL_NAMES = [
  'get_finance_metrics', 'get_online_metrics', 'get_salon_metrics', 'recall_my_decisions', 'recall_decisions', 'my_lessons',
  'list_lessons', 'get_timeline', 'list_work_reports', 'usage_summary', 'open_items', 'latest_proposal', 'explain_proposal',
  'list_session_reports',
  // The division data (version 2): budget room, one metric over the year, the company at a glance, data quality,
  // and the rows behind the standing numbers.
  'get_budget_room', 'get_metric_series', 'get_company_overview', 'get_data_quality', 'get_repair_tickets', 'get_supplier_invoices',
  'get_waiting_conversations', 'get_low_stock_interest',
  // Wave 2: the marketplace warehouses' stock (Finance's; Online asks for it) and each product's period (Online's; Finance asks);
  // each refund with its customer's year, reviews and messages (Online's; Finance asks); the store journey (Online's).
  'get_marketplace_stock', 'get_product_performance', 'get_return_cases', 'get_store_journey',
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export type AssistantProfile = {
  id: AssistantId;
  /** The department's name, e.g. 'Finance Department'. */
  title: string;
  /** The person role it serves; null for the manager and the Legal Team. */
  serves: string | null;
  /** 'live' = answers and plans; 'saves-requests' only keeps requests; 'placeholder' has nothing running. */
  status: 'live' | 'saves-requests' | 'placeholder';
  /** The body of skills/<id>/SKILL.md, frontmatter removed. */
  skill: string;
  reads: readonly ReadToolName[];
  /** Documentation of fixed worker code paths. A write is never a tool. */
  writes: readonly ('propose' | 'report')[];
  models: Partial<Record<ModelJob, ModelSetting>>;
  /** Its own Meterless H-MEM folder. */
  memory: AssistantId;
  /** The standing lessons a person adopted for it. Only a stored (database) profile has any. */
  lessons: readonly ProfileLesson[];
  /** The stored version this profile was read at; null for a file profile. */
  version: number | null;
  /** Where this profile came from: the files under skills/, or its row in public.assistant_profiles. */
  source: 'files' | 'database';
};

type Shape = Omit<AssistantProfile, 'skill' | 'models' | 'lessons' | 'version' | 'source'> & { jobs: readonly ModelJob[] };

const SHAPES: Record<AssistantId, Shape> = {
  owner: {
    id: 'owner', title: 'Owner HQ', serves: 'owner', status: 'live',
    reads: [
      'get_finance_metrics', 'get_company_overview', 'get_budget_room', 'get_metric_series', 'get_repair_tickets', 'get_supplier_invoices',
      'get_waiting_conversations', 'get_marketplace_stock', 'get_product_performance', 'get_return_cases', 'get_store_journey', 'recall_decisions', 'list_lessons', 'get_timeline',
      'open_items', 'latest_proposal', 'usage_summary', 'explain_proposal',
    ],
    writes: ['propose'], jobs: ['route', 'code', 'answer'], memory: 'owner',
  },
  finance: {
    id: 'finance', title: 'Finance Department', serves: 'finance_owner', status: 'live',
    reads: [
      'get_finance_metrics', 'get_budget_room', 'get_metric_series', 'get_supplier_invoices', 'get_marketplace_stock', 'recall_my_decisions', 'my_lessons', 'latest_proposal',
      'explain_proposal',
    ],
    writes: ['propose', 'report'], jobs: ['plan', 'code', 'answer'], memory: 'finance',
  },
  online: {
    id: 'online', title: 'Online Customer Service', serves: 'online_staff', status: 'live',
    reads: [
      'get_online_metrics', 'get_metric_series', 'get_waiting_conversations', 'get_low_stock_interest', 'get_product_performance', 'get_return_cases', 'get_store_journey',
      'recall_my_decisions', 'my_lessons',
    ],
    writes: ['propose', 'report'], jobs: ['plan', 'code', 'answer'], memory: 'online',
  },
  // In production this is Cindy's own backend (her family and personal data never cross); here it shows the
  // pattern on synthetic salon data.
  salon: {
    id: 'salon', title: 'Salon Department (stand-in for Cindy)', serves: 'head_stylist', status: 'live',
    reads: ['get_salon_metrics', 'get_metric_series', 'get_repair_tickets', 'recall_my_decisions', 'my_lessons'],
    writes: ['propose', 'report'], jobs: ['plan', 'code', 'answer'], memory: 'salon',
  },
  manager: {
    id: 'manager', title: 'HQ Manager', serves: null, status: 'live',
    reads: ['list_work_reports', 'list_session_reports', 'usage_summary', 'list_lessons', 'get_timeline', 'open_items', 'recall_decisions', 'explain_proposal', 'get_data_quality'],
    writes: ['report'], jobs: ['code', 'answer', 'review'], memory: 'manager',
  },
  // Terms, contracts and policies. Like the manager it has no phone number and no person: staff reach it through a door,
  // the owner asks it by text through Owner HQ. It reads only what holds no business data (its own memory and lessons),
  // and answers a question (a lookup, then the words); it plans and reviews nothing.
  legal: {
    id: 'legal', title: 'Legal Team', serves: null, status: 'live',
    reads: ['recall_my_decisions', 'my_lessons'],
    writes: ['report'], jobs: ['code', 'answer'], memory: 'legal',
  },
};

const DEFAULT_ROUTER_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const DEFAULT_PLAN_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

/** The settings for every job. Models already proven live on this key are the defaults. */
function jobSettings(env: NodeJS.ProcessEnv): Record<ModelJob, ModelSetting> {
  const named = (name: string, fallback: string) => env[name]?.trim() || fallback;
  const router = named('NEMOTRON_ROUTER_MODEL', DEFAULT_ROUTER_MODEL);
  return {
    route: { model: router, thinking: false, maxTokens: 600, temperature: 0 },
    plan: { model: named('NEMOTRON_PLAN_MODEL', DEFAULT_PLAN_MODEL), thinking: true, maxTokens: 16000, temperature: 0.4 },
    code: { model: named('CODE_MODEL', router), thinking: false, maxTokens: 1200, temperature: 0 },
    answer: { model: named('ANSWER_MODEL', router), thinking: false, maxTokens: 400, temperature: 0.2 },
    review: { model: named('REVIEW_MODEL', router), thinking: true, maxTokens: 6000, temperature: 0.2 },
  };
}

// ---- Skills ------------------------------------------------------------------------------------

const SKILLS_DIR = path.join(import.meta.dirname, '..', 'skills');
const Frontmatter = z.object({ name: z.string().min(1), description: z.string().min(1) });
const skills = new Map<AssistantId, { frontmatter: z.infer<typeof Frontmatter>; body: string }>();

function readSkill(id: AssistantId) {
  const cached = skills.get(id);
  if (cached) return cached;
  const text = fs.readFileSync(path.join(SKILLS_DIR, id, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`skill ${id} has no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const parsed = Frontmatter.safeParse(fields);
  if (!parsed.success || parsed.data.name !== `fortune-hq-${id}`) {
    throw new Error(`skill ${id} needs frontmatter with name "fortune-hq-${id}" and a description`);
  }
  const entry = { frontmatter: parsed.data, body: text.slice(match[0].length).trim() };
  skills.set(id, entry);
  return entry;
}

export function skillFrontmatter(id: AssistantId): { name: string; description: string } {
  return { ...readSkill(id).frontmatter };
}

// ---- Profiles ----------------------------------------------------------------------------------

export function loadProfiles(env: NodeJS.ProcessEnv): Record<AssistantId, AssistantProfile> {
  const settings = jobSettings(env);
  const profiles = {} as Record<AssistantId, AssistantProfile>;
  for (const id of AssistantId.options) {
    const { jobs, ...shape } = SHAPES[id];
    const models: Partial<Record<ModelJob, ModelSetting>> = {};
    for (const job of jobs) models[job] = { ...settings[job] };
    profiles[id] = { ...shape, reads: [...shape.reads], writes: [...shape.writes], skill: readSkill(id).body, models, lessons: [], version: null, source: 'files' };
  }
  return profiles;
}

/**
 * Exactly the profile's tools, in its order. A name missing from `all` stops the start-up instead of
 * quietly leaving a hole; a tool that is not on the list is never returned.
 */
export function pickTools(all: Record<string, ReadTool>, profile: AssistantProfile): ReadTool[] {
  return profile.reads.map((name) => {
    const tool = Object.hasOwn(all, name) ? all[name] : undefined;
    if (!tool) throw new Error(`read tool ${name} is not available for ${profile.id}`);
    if (tool.name !== name) throw new Error(`read tool ${name} is registered under the name ${tool.name}`);
    return tool;
  });
}

// ---- Profiles in the database ---------------------------------------------------------------------

/** The worker's profiles: the stored row of each assistant (read about once a minute), the files where there is none. */
export function createProfileSource(options: Omit<ProfileSourceOptions, 'files' | 'readNames'> & { env: NodeJS.ProcessEnv }): ProfileSource {
  const { env, ...rest } = options;
  return buildProfileSource({ ...rest, files: () => loadProfiles(env), readNames: READ_TOOL_NAMES });
}

/** The profile a door serves, from the answer of `door_profile`: refused in plain words when it breaks a rule the worker applies. */
export function profileFromDoor(raw: unknown, env: NodeJS.ProcessEnv = {}): AssistantProfile {
  return doorProfile(raw, loadProfiles(env), READ_TOOL_NAMES);
}

/** Stores the file profiles that have no row yet (`force`: replaces the others' words and models too). See seed.ts. */
export function seedProfiles(db: Queryable, env: NodeJS.ProcessEnv, options: { force?: boolean; now?: Date } = {}): Promise<SeedResult[]> {
  return seedFromFiles(db, loadProfiles(env), options);
}

/** Puts an earlier version of a profile back as a new version (the history keeps every version). See restore.ts. */
export function restoreProfileVersion(db: Queryable, assistant: AssistantId, version: number, options: { now?: Date } = {}): Promise<RestoreResult> {
  return restoreVersion(db, assistant, version, { ...options, readNames: READ_TOOL_NAMES });
}

export type { RestoreResult } from './restore.ts';
export { MONEY_READS, ProfileLesson as ProfileLessonSchema, ProfileRow, READ_SCOPE, checkProfileRow, parseProfileRows } from './rows.ts';
export type { ParsedProfileRows, ReadScope } from './rows.ts';
export { DEFAULT_PROFILE_TTL_MS, MANAGER_LESSONS_HEADING, OWNER_LESSONS_HEADING, skillWithLessons } from './source.ts';
export { KIND_LABEL, MANAGER_NOTES_HEADING, MAX_LESSONS, MAX_MANAGER_NOTES, applyProfileChange, changeOf, checkChangeText, dataNeverStored, describeChange, lessonAddedBy, managerNotes, withManagerNotes } from './changes.ts';
export type { AppliedChange, ChangeOptions, ProfileChange, ProfileContent } from './changes.ts';
export type { ProfileSnapshot, ProfileSource, ProfileSourceOptions } from './source.ts';
export { canonicalJson, ownerChoices } from './seed.ts';
export type { OwnerChoices, Queryable, SeedAction, SeedResult } from './seed.ts';
export { issueDoorToken, newDoorToken, tokenHash, writeTokenFile } from './tokens.ts';
export { DoorProfile, doorSkill } from './door.ts';
export type { DoorSkillOptions, DoorTool } from './door.ts';
export type { ProfileLesson };
