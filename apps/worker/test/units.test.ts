import { describe, expect, it } from 'vitest';
import type { AssistantMemory } from '@fahq/brain';
import { parseCommand } from '../src/commands.ts';
import { PlanError, planDigest, writePlans } from '../src/finance.ts';
import { dataMock, modelMock, validPlans } from './fixtures.ts';

describe('parseCommand', () => {
  it('reads approval commands exactly, case and spacing aside', () => {
    expect(parseCommand('send 2 123456')).toEqual({ kind: 'send', planRank: 2, code: '123456' });
    expect(parseCommand('  CONFIRM   654321 ')).toEqual({ kind: 'confirm', code: '654321' });
    expect(parseCommand('decline 111111')).toEqual({ kind: 'decline', code: '111111' });
    expect(parseCommand('STATUS')).toEqual({ kind: 'status' });
  });

  it('treats "yes" and near-misses as malformed, never as approval', () => {
    for (const t of ['yes', 'OK', 'send 4 123456', 'SEND 2', 'CONFIRM 12345', 'confirm it']) {
      expect(parseCommand(t)?.kind).toBe('malformed');
    }
    expect(parseCommand('Give me three plans to double profit')).toBeNull();
  });
});

// MOCK memory: no past decisions.
const memoryMock = { recallDecisions: () => [], declinedSimilarTo: () => [] } as unknown as AssistantMemory;
const base = { planModel: 'nvidia/ultra', data: dataMock, memory: memoryMock, now: new Date('2026-10-26T12:00:00Z'), request: 'Three plans to double profit', period: '2026-09' as const };

describe('writePlans', () => {
  it('accepts valid plans on the first try', async () => {
    const result = await writePlans({ ...base, model: modelMock() });
    expect(result.attempts).toBe(1);
    expect(result.citedMetricIds).toContain('m:salon.revenue.wash_set');
    expect(planDigest(result.plans).split('\n')).toHaveLength(3);
  });

  it('gives the model one correction round with the exact objections', async () => {
    const wrong = structuredClone(validPlans);
    wrong.plans[0]!.evidence[0]!.value = 99999;
    const model = modelMock([JSON.stringify(wrong), JSON.stringify(validPlans)]);
    const result = await writePlans({ ...base, model });
    expect(result.attempts).toBe(2);
    expect(model.calls).toEqual(['finance.plans', 'finance.plans']);
  });

  it('fails plainly when the plans still do not check out', async () => {
    const wrong = structuredClone(validPlans);
    wrong.plans[1]!.summary = 'This adds $50,000.';
    await expect(writePlans({ ...base, model: modelMock([JSON.stringify(wrong)]) })).rejects.toBeInstanceOf(PlanError);
  });
});
