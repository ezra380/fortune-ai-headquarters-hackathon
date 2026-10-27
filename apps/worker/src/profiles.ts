import { AssistantId } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { createProfileSource, loadProfiles, skillWithLessons, type AssistantProfile } from '@fahq/profiles';
import type { WorkerDeps } from './common.ts';
import type { Store } from './store.ts';

// The profiles the worker runs on (WorkerDeps.profiles). Each assistant's current profile is its row in
// public.assistant_profiles, read again about once a minute; an assistant with no row keeps its file profile.
// PROFILES_SOURCE=files runs on the files alone, on purpose. Anything else needs the table to be readable
// at start-up: a worker that cannot tell which profile it should use does not start.
//
// The database is where the standing lessons live. Meterless H-MEM is a cache of them on this machine (the plan
// writers read lessons from it): every time the profiles are read, a lesson this machine has not seen is
// remembered there, so a lesson adopted on another machine reaches this one within the minute, and a lesson the
// profile no longer holds (put back from the history, or let go at the limit) is taken back from it.

type Memory = Pick<Brain, 'memory'>;

/**
 * Keeps this machine's H-MEM in step with the stored profiles, both ways:
 *  - each lesson a profile holds is remembered once (a lesson is keyed by the recommendation it came from);
 *  - a copy of a profile lesson that the profile no longer holds (a version was put back, or the 50-lesson limit let it go)
 *    is taken back, so the plan writers and `my_lessons` stop reading it. The manager keeps a "For <assistant>: ..." copy of
 *    each lesson and keeps it for as long as any profile holds the lesson.
 * A lesson that is not a copy of a profile lesson (one adopted before profiles were stored) is never touched.
 * `live` holds the keys the last read remembered, so only what is new is looked up.
 */
function syncLessons(brain: Memory, profiles: Readonly<Record<AssistantId, AssistantProfile>>, live: { keys: Set<string> }): void {
  const keys = new Set<string>();
  const held = new Set<string>();
  for (const id of AssistantId.options) {
    for (const lesson of profiles[id].lessons) {
      const key = `${id}:${lesson.source}`;
      keys.add(key);
      held.add(lesson.source);
      if (live.keys.has(key)) continue;
      brain.memory(id).rememberLesson({ recommendationId: lesson.source, text: lesson.text, adoptedBy: 'the profile', reviewId: 'profile', runId: 'profile-sync', fromProfile: true });
    }
  }
  const taken = { reason: 'no longer in the stored profile', runId: 'profile-sync' };
  for (const id of AssistantId.options) {
    brain.memory(id).retireProfileLessons(id === 'manager' ? held : new Set(profiles[id].lessons.map((l) => l.source)), taken);
  }
  live.keys = keys;
}

export async function workerProfiles(
  env: NodeJS.ProcessEnv, store: Pick<Store, 'assistantProfiles'>, now: () => Date, log: (line: string) => void = console.error, brain?: Memory,
): Promise<WorkerDeps['profiles']> {
  let get: (id: AssistantId) => AssistantProfile;
  let refresh: (() => Promise<void>) | undefined;
  if (env.PROFILES_SOURCE === 'files') {
    const files = loadProfiles(env);
    get = (id) => files[id];
    log('worker: profiles from the files only (PROFILES_SOURCE=files)');
  } else {
    const live = { keys: new Set<string>() };
    const source = createProfileSource({
      env, load: () => store.assistantProfiles(), now, onProblem: (message) => log(`worker: profiles: ${message}`),
      ...(brain ? { onLoaded: (profiles: Readonly<Record<AssistantId, AssistantProfile>>) => syncLessons(brain, profiles, live) } : {}),
    });
    try {
      const loaded = await source.refresh({ force: true });
      log(`worker: profiles from the database: ${loaded.fromDatabase.join(', ') || 'none'}; from the files: ${loaded.fromFiles.join(', ') || 'none'}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : 'the profiles could not be loaded'}. Apply supabase/migrations/20261027100000_profiles.sql and run scripts/seed-profiles.ts, or set PROFILES_SOURCE=files to run on the files.`,
      );
    }
    get = (id) => source.profile(id);
    refresh = async () => { await source.refresh({ force: true }); };
  }
  return {
    skill: (id) => skillWithLessons(get(id)),
    model: (id, job) => {
      const profile = get(id);
      const setting = profile.models[job];
      if (!setting) throw new Error(`The ${profile.title} assistant has no model for "${job}".`);
      return setting.model;
    },
    reads: (id) => get(id).reads,
    ...(refresh ? { refresh } : {}),
  };
}
