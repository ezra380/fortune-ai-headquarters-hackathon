import type { ModelPort } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import type { WorkerDeps } from '../src/common.ts';
import { startScreen } from '../src/screen.ts';

// GUARD_PROVIDER=nvidia: the screen asks the safety model through its own client (NVIDIA directly) while every
// other call goes through Nightshift, which did not serve the content-safety model on 2026-10-27.

const answering = (text: string): ModelPort => ({
  chat: async () => ({ text, model: 'MOCK/guard', inputTokens: 1, outputTokens: 1, costUsd: 0 }),
});
const down: ModelPort = {
  chat: async () => {
    throw new Error('meterless returned HTTP 404; response body withheld');
  },
};
const depsWith = (guard: WorkerDeps['guard']) => ({ models: { nvidia: down, planModel: 'p', routerModel: 'r' }, guard }) as unknown as WorkerDeps;

describe('the safety screen client', () => {
  it("asks the guard's own client when it has one", async () => {
    const screened = await startScreen(depsWith({ model: 'MOCK/guard', client: answering('{"User Safety": "safe"}') }), 'What were online sales last week?');
    expect(screened).toMatchObject({ off: false, result: { safe: true, reason: null } });
  });

  it("falls back to the models' client, and fails closed when that cannot serve the safety model", async () => {
    const screened = await startScreen(depsWith({ model: 'MOCK/guard' }), 'What were online sales last week?');
    expect(screened).toMatchObject({ off: false, result: { safe: false, reason: 'the safety check could not run' } });
  });
});
