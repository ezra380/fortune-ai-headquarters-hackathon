import type { AssistantId } from '@fahq/contracts';
import { createProfileSource, loadProfiles, skillWithLessons, type AssistantProfile } from '@fahq/profiles';
import type { WorkerDeps } from './common.ts';
import type { Store } from './store.ts';

// The profiles the worker runs on (WorkerDeps.profiles). Each assistant's current profile is its row in
// public.assistant_profiles, read again about once a minute; an assistant with no row keeps its file profile.
// PROFILES_SOURCE=files runs on the files alone, on purpose. Anything else needs the table to be readable
// at start-up: a worker that cannot tell which profile it should use does not start.

export async function workerProfiles(
  env: NodeJS.ProcessEnv, store: Pick<Store, 'assistantProfiles'>, now: () => Date, log: (line: string) => void = console.error,
): Promise<WorkerDeps['profiles']> {
  let get: (id: AssistantId) => AssistantProfile;
  if (env.PROFILES_SOURCE === 'files') {
    const files = loadProfiles(env);
    get = (id) => files[id];
    log('worker: profiles from the files only (PROFILES_SOURCE=files)');
  } else {
    const source = createProfileSource({ env, load: () => store.assistantProfiles(), now, onProblem: (message) => log(`worker: profiles: ${message}`) });
    try {
      const loaded = await source.refresh({ force: true });
      log(`worker: profiles from the database: ${loaded.fromDatabase.join(', ') || 'none'}; from the files: ${loaded.fromFiles.join(', ') || 'none'}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : 'the profiles could not be loaded'}. Apply supabase/migrations/20261027100000_profiles.sql and run scripts/seed-profiles.ts, or set PROFILES_SOURCE=files to run on the files.`,
      );
    }
    get = (id) => source.profile(id);
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
  };
}
