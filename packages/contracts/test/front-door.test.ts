import { describe, expect, it } from 'vitest';
import { FrontDoorDecision, Intent } from '../src/index.ts';

// What the router model may decide. The model's JSON is parsed with this schema before anything uses it.

const decision = (over: Record<string, unknown> = {}) => ({
  intent: 'plans', risks: ['money'], targetAssistant: 'owner', confidence: 0.9, reason: 'asks for plans for the whole business', ...over,
});

describe('FrontDoorDecision', () => {
  it('knows four intents: plans, question, status and unknown', () => {
    expect(Intent.options).toEqual(['plans', 'question', 'status', 'unknown']);
  });

  it.each(['plans', 'question', 'status', 'unknown'])('accepts the intent %s', (intent) => {
    expect(FrontDoorDecision.safeParse(decision({ intent })).success).toBe(true);
  });

  it('refuses the retired intent "request", and any word that is not an intent', () => {
    for (const intent of ['request', 'plan', 'QUESTION', '', 'approve']) {
      expect(FrontDoorDecision.safeParse(decision({ intent })).success, intent).toBe(false);
    }
  });

  it.each(['owner', 'finance', 'salon', 'online', 'manager', 'legal'])('accepts the target %s', (targetAssistant) => {
    expect(FrontDoorDecision.safeParse(decision({ targetAssistant })).success).toBe(true);
  });

  it('refuses an unknown target, a risk that is not listed, and a confidence outside 0 to 1', () => {
    expect(FrontDoorDecision.safeParse(decision({ targetAssistant: 'marketing' })).success).toBe(false);
    expect(FrontDoorDecision.safeParse(decision({ risks: ['legal'] })).success).toBe(false);
    expect(FrontDoorDecision.safeParse(decision({ confidence: 1.1 })).success).toBe(false);
    expect(FrontDoorDecision.safeParse(decision({ reason: 'x'.repeat(401) })).success).toBe(false);
  });
});
