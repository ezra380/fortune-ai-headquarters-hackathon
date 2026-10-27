import { describe, expect, it } from 'vitest';
import type { ModelPort } from '@fahq/contracts';
import { ROUTER_SYSTEM, routeText } from '../src/router.ts';

// The front door's model is a FAKE here: these tests pin the prompt it is given and what the worker
// does with its answer.

function replying(text: string) {
  const calls: Parameters<ModelPort['chat']>[0][] = [];
  const port: ModelPort = {
    async chat(input) {
      calls.push(input);
      return { text, model: 'FAKE/router', inputTokens: 40, outputTokens: 30, costUsd: 0 };
    },
  };
  return { port, calls };
}
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ intent: 'plans', risks: [], targetAssistant: 'owner', confidence: 0.9, reason: 'scripted', ...over });

describe('the front door prompt', () => {
  it('describes each department by what it knows, and the manager by how the assistants work', () => {
    expect(ROUTER_SYSTEM).toContain("owner: the owner's chief of staff, and any request for plans for the whole business");
    expect(ROUTER_SYSTEM).toContain('finance: money, invoices, budgets, and the view across both businesses');
    expect(ROUTER_SYSTEM).toContain("salon: appointments, salon customers, repairs, the head stylist's schedule");
    expect(ROUTER_SYSTEM).toContain('online: online customers, emails and texts, online orders, ads and email marketing');
    expect(ROUTER_SYSTEM).toContain("manager: how the assistants are working: their reports, usage and lessons");
  });

  it('tells plans from questions, with the explain-why example as a question', () => {
    expect(ROUTER_SYSTEM).toContain('plans: asks for plans, ideas or proposals to act on');
    expect(ROUTER_SYSTEM).toContain('question: asks for facts or an explanation ("why did you propose plan 2?" is a question)');
    expect(ROUTER_SYSTEM).toContain('"intent":"plans"|"question"|"status"|"unknown"');
    expect(ROUTER_SYSTEM).not.toContain('"request"');
  });
});

describe('routeText', () => {
  it('returns the decision, calling the router model with thinking off and the text as data', async () => {
    const fake = replying(answer({ intent: 'question', targetAssistant: 'online', risks: ['customer'] }));
    const routed = await routeText(fake.port, 'FAKE/model', 'Why did you propose plan 2?', 'owner');
    expect(routed).toMatchObject({ valid: true, model: 'FAKE/router', inputTokens: 40, outputTokens: 30 });
    expect(routed.decision).toMatchObject({ intent: 'question', targetAssistant: 'online', risks: ['customer'] });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ purpose: 'front-door', model: 'FAKE/model', json: true, thinking: false, temperature: 0, system: ROUTER_SYSTEM });
    expect(JSON.parse(fake.calls[0]!.user)).toEqual({ message: 'Why did you propose plan 2?' });
  });

  it('does not accept the retired intent "request": the text stays with the sender, marked unknown', async () => {
    const routed = await routeText(replying(answer({ intent: 'request', targetAssistant: 'finance' })).port, 'FAKE/model', 'Three plans please', 'owner');
    expect(routed.valid).toBe(false);
    expect(routed.decision).toEqual({ intent: 'unknown', risks: [], targetAssistant: 'owner', confidence: 0, reason: 'router output did not validate' });
  });

  it('keeps a text that came back as not JSON with the sender', async () => {
    const routed = await routeText(replying('I think this is about money').port, 'FAKE/model', 'Hello', 'salon');
    expect(routed).toMatchObject({ valid: false, decision: { intent: 'unknown', targetAssistant: 'salon' } });
  });
});
