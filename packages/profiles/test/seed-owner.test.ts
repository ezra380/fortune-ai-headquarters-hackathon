import { describe, expect, it } from 'vitest';
import { ownerChoices } from '../src/index.ts';

// Which read tools and models a reseed (--force) must leave alone: those whose latest change was the owner's. Pure, from the
// version history; the same thing against a real database is in supabase/tests/profiles.test.ts.

const setting = (model: string) => ({ model, thinking: false, maxTokens: 100, temperature: 0 });
const version = (madeBy: string, reads: string[], models: Record<string, ReturnType<typeof setting>>) => ({ made_by: madeBy, snapshot: { reads, models } });

const first = version('seed', ['a', 'b'], { code: setting('m1'), answer: setting('m1') });

describe('ownerChoices', () => {
  it('finds nothing in a history of one version, or none', () => {
    expect(ownerChoices([])).toEqual({ reads: null, models: {} });
    expect(ownerChoices([first])).toEqual({ reads: null, models: {} });
  });

  it('keeps the read tools an owner version changed, and the models of the jobs it changed', () => {
    const owned = version('owner', ['a', 'c'], { code: setting('m1'), answer: setting('m2') });
    expect(ownerChoices([first, owned])).toEqual({ reads: ['a', 'c'], models: { answer: setting('m2') } });
  });

  it('does not keep what the owner left as it was', () => {
    const titleOnly = version('owner', ['a', 'b'], { code: setting('m1'), answer: setting('m1') });
    expect(ownerChoices([first, titleOnly])).toEqual({ reads: null, models: {} });
  });

  it('keeps an owner choice through the versions that change something else', () => {
    const owned = version('owner', ['a', 'c'], { code: setting('m1'), answer: setting('m2') });
    const later = version('manager', ['a', 'c'], { code: setting('m1'), answer: setting('m2') }); // a note: reads and models as they were
    const reseed = version('seed', ['a', 'c'], { code: setting('m1'), answer: setting('m2') });
    expect(ownerChoices([first, owned, later, reseed])).toEqual({ reads: ['a', 'c'], models: { answer: setting('m2') } });
  });

  it('drops an owner choice that someone else changed again, per field', () => {
    const owned = version('owner', ['a', 'c'], { code: setting('m2'), answer: setting('m2') });
    const managerReads = version('manager', ['a'], { code: setting('m2'), answer: setting('m2') });
    expect(ownerChoices([first, owned, managerReads])).toEqual({ reads: null, models: { code: setting('m2'), answer: setting('m2') } });
    const seedModel = version('seed', ['a', 'c'], { code: setting('m1'), answer: setting('m2') });
    expect(ownerChoices([first, owned, seedModel])).toEqual({ reads: ['a', 'c'], models: { answer: setting('m2') } });
  });

  it('counts an owner putting an earlier version back as the owner\'s choice, and the latest of several changes wins', () => {
    const byManager = version('manager', ['a', 'z'], { code: setting('m1'), answer: setting('m1') });
    const putBack = version('owner', ['a', 'b'], { code: setting('m1'), answer: setting('m1') });
    expect(ownerChoices([first, byManager, putBack])).toEqual({ reads: ['a', 'b'], models: {} });
    const ownerThenManager = [first, version('owner', ['a', 'c'], { code: setting('m1'), answer: setting('m1') }), byManager];
    expect(ownerChoices(ownerThenManager).reads).toBeNull();
  });

  it('reads the order of the read tools as part of the choice, and ignores the order of keys in a setting', () => {
    const reordered = version('owner', ['b', 'a'], { code: setting('m1'), answer: setting('m1') });
    expect(ownerChoices([first, reordered]).reads).toEqual(['b', 'a']);
    const keysShuffled = { made_by: 'owner', snapshot: { reads: ['a', 'b'], models: { code: { temperature: 0, maxTokens: 100, thinking: false, model: 'm1' }, answer: setting('m1') } } };
    expect(ownerChoices([first, keysShuffled])).toEqual({ reads: null, models: {} });
  });
});
