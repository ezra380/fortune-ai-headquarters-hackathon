import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '@fahq/brain';
import type { AssistantId } from '@fahq/contracts';
import { workerProfiles } from '../src/profiles.ts';
import { haveMeterless, meterlessDir } from './localdb.ts';
import { memoryProfiles } from './profile-port.ts';

// The lessons H-MEM holds on this machine follow the stored profiles, both ways: a lesson a profile holds is remembered,
// and a copy of one it no longer holds (a version was put back, or the 50-lesson limit let it go) is taken back, so the plan
// writers and `my_lessons` stop reading it. Real Meterless engines, profile tables in memory. (The same thing end to end
// through a plan writer is in manager-decides.test.ts.)

if (!haveMeterless) console.warn('SKIPPED profile-lessons tests: needs Meterless (scripts/setup-meterless.sh)');

const quiet = () => undefined;
const now = () => new Date('2026-10-27T12:00:00Z');
const lesson = (source: string, text: string, by: 'owner' | 'manager' = 'owner') => ({ text, source, adoptedAt: '2026-10-27T09:00:00.000Z', by });
const A = lesson('rec-a', 'Quote the month in every answer.');
const B = lesson('rec-b', 'Give the return as well as the spend.');
const C = lesson('rec-c', 'Say when a number is missing.', 'manager');

const newBrain = () => openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-lessons-')), actor: 'profile-lessons-test' });
const texts = (brain: Brain, id: AssistantId) => brain.memory(id).lessons().map((m) => m.content);

describe.skipIf(!haveMeterless)('the lessons H-MEM copies from the stored profiles', () => {
  it('remembers each lesson a profile holds, once, whoever applied it', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    tables.row('finance').lessons = [A, B, C];
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    await profiles.refresh!();
    await profiles.refresh!();
    expect(texts(brain, 'finance').sort()).toEqual([A.text, B.text, C.text].sort());
    expect(texts(brain, 'online')).toEqual([]);
  });

  it('takes a lesson back when the profile no longer holds it (a version put back), and the manager\'s copy of it too', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    tables.row('finance').lessons = [A, B];
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    // What the manager keeps beside it: "For finance: ..." for each lesson of another assistant's profile.
    for (const l of [A, B]) {
      brain.memory('manager').rememberLesson({ recommendationId: l.source, text: `For finance: ${l.text}`, adoptedBy: 'the owner', reviewId: 'rv', runId: 'run', fromProfile: true });
    }
    expect(texts(brain, 'manager').sort()).toEqual([`For finance: ${A.text}`, `For finance: ${B.text}`].sort());

    tables.row('finance').lessons = [A]; // the owner put an earlier version back
    await profiles.refresh!();
    expect(texts(brain, 'finance')).toEqual([A.text]);
    expect(texts(brain, 'manager')).toEqual([`For finance: ${A.text}`]);
    // Reading again changes nothing, and nothing is taken back twice.
    await profiles.refresh!();
    expect(texts(brain, 'finance')).toEqual([A.text]);
  });

  it('takes back the lesson the limit of fifty let go, and keeps the rest', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    const fifty = Array.from({ length: 50 }, (_, i) => lesson(`rec-${i}`, `Lesson number ${String.fromCharCode(97 + (i % 26))}${i}.`));
    tables.row('salon').lessons = fifty;
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    expect(brain.memory('salon').lessons(100)).toHaveLength(50);
    tables.row('salon').lessons = [...fifty.slice(1), lesson('rec-new', 'The newest lesson.')]; // what the manager's or the owner's next write does at the limit
    await profiles.refresh!();
    const kept = brain.memory('salon').lessons(100).map((m) => m.content);
    expect(kept).toHaveLength(50);
    expect(kept).toContain('The newest lesson.');
    expect(kept).not.toContain(fifty[0]!.text);
    expect(kept).toContain(fifty[1]!.text);
  });

  it('never takes back a lesson that was not a copy of one in a profile', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    brain.memory('finance').rememberLesson({ recommendationId: 'legacy-1', text: 'A lesson adopted before profiles were stored.', adoptedBy: 'the owner', reviewId: 'rv', runId: 'run' });
    tables.row('finance').lessons = [A];
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    tables.row('finance').lessons = [];
    await profiles.refresh!();
    expect(texts(brain, 'finance')).toEqual(['A lesson adopted before profiles were stored.']);
  });

  it('takes back only the assistant\'s own lessons: another assistant\'s stay', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    tables.row('finance').lessons = [A];
    tables.row('online').lessons = [B];
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    tables.row('finance').lessons = [];
    await profiles.refresh!();
    expect(texts(brain, 'finance')).toEqual([]);
    expect(texts(brain, 'online')).toEqual([B.text]);
  });

  it('brings a lesson back, once, when the profile holds it again (a version put back that was itself put back)', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    tables.row('finance').lessons = [A, B];
    const profiles = await workerProfiles({}, tables.port, now, quiet, brain);
    tables.row('finance').lessons = [A];
    await profiles.refresh!();
    expect(texts(brain, 'finance')).toEqual([A.text]);
    tables.row('finance').lessons = [A, B];
    await profiles.refresh!();
    await profiles.refresh!();
    expect(texts(brain, 'finance').sort()).toEqual([A.text, B.text].sort());
    expect(texts(brain, 'finance').filter((t) => t === B.text)).toHaveLength(1);
  });

  it('catches up when a worker starts after the table changed while it was down', async () => {
    const brain = await newBrain();
    const tables = memoryProfiles();
    tables.row('finance').lessons = [A, B];
    await workerProfiles({}, tables.port, now, quiet, brain); // the old worker remembers both
    tables.row('finance').lessons = [A]; // the owner put a version back while no worker was running
    await workerProfiles({}, tables.port, now, quiet, brain); // the new worker's first read takes B back
    expect(texts(brain, 'finance')).toEqual([A.text]);
  });

  it('does nothing to H-MEM when the worker runs on the files alone', async () => {
    const brain = await newBrain();
    brain.memory('finance').rememberLesson({ recommendationId: 'rec-a', text: A.text, adoptedBy: 'the owner', reviewId: 'rv', runId: 'run', fromProfile: true });
    const tables = memoryProfiles();
    await workerProfiles({ PROFILES_SOURCE: 'files' }, tables.port, now, quiet, brain);
    expect(texts(brain, 'finance')).toEqual([A.text]);
  });
});
