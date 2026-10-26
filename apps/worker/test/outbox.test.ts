import { describe, expect, it } from 'vitest';
import type { DeliveryPort } from '@fahq/contracts';
import type { WorkerDeps } from '../src/flows.ts';
import { flushOutbox } from '../src/outbox.ts';
import type { OutboxRow } from '../src/store.ts';

// FAKES: an in-memory outbox and a scripted SMS sender, to pin down what happens on each failure.

function setup(sendResults: (Error | string)[], rows: Partial<OutboxRow & { claimed_at: string | null }>[]) {
  const table = rows.map((r, i) => ({
    id: `row-${i}`, channel: 'sms' as const, to_person_id: 'demo-p-owner', from_assistant: 'finance' as const,
    body: 'Reply SEND <1-3> 123456', attachment_ref: null, status: 'pending', attempts: 0, claimed_at: null as string | null, last_error: '', ...r,
  }));
  const sends: string[] = [];
  let settleFails = false;
  const store = {
    strandedOutbox: async (cutoff: Date) => table.filter((r) => r.status === 'sending' && (!r.claimed_at || r.claimed_at < cutoff.toISOString())),
    pendingOutbox: async () => table.filter((r) => r.status === 'pending'),
    registeredPhones: async () => new Set(['+15550111001']),
    claimOutbox: async (id: string, now: Date) => {
      const r = table.find((x) => x.id === id && x.status === 'pending');
      if (!r) return false;
      Object.assign(r, { status: 'sending', claimed_at: now.toISOString() });
      return true;
    },
    person: async () => ({ id: 'demo-p-owner', name: 'Demo Owner', role: 'owner', phone: '+15550111001', assistant_id: 'owner' }),
    assistantNumber: async () => '+15550100002',
    settleOutbox: async (row: OutboxRow, s: { status: string; error?: string }) => {
      if (settleFails && s.status === 'sent') throw new Error('database down');
      Object.assign(table.find((x) => x.id === row.id)!, { status: s.status, last_error: s.error ?? '', body: row.body.replace(/\d{6}/g, '••••••') });
    },
    retryOutbox: async (row: OutboxRow, error: string) => {
      Object.assign(table.find((x) => x.id === row.id)!, { status: 'pending', attempts: row.attempts + 1, last_error: error, claimed_at: null });
    },
  };
  const delivery = {
    sendSms: async ({ outboxId }: { outboxId: string }) => {
      sends.push(outboxId);
      const next = sendResults.shift();
      if (next instanceof Error) throw next;
      return { providerMessageId: next ?? 'SM-ok' };
    },
  } as unknown as DeliveryPort;
  const deps = { store, delivery, smsLive: true, now: () => new Date('2026-10-26T12:00:00Z') } as unknown as WorkerDeps;
  return { table, sends, deps, failSettle: () => { settleFails = true; } };
}

describe('outbox delivery', () => {
  it('retries a rate-limit or Twilio outage, at most three tries, then fails', async () => {
    const busy = () => new Error('Twilio refused the message (HTTP 503)');
    const { table, sends, deps } = setup([busy(), busy(), busy()], [{}]);
    for (let i = 0; i < 4; i++) await flushOutbox(deps);
    expect(sends).toHaveLength(3);
    expect(table[0]).toMatchObject({ status: 'failed', body: 'Reply SEND <1-3> ••••••' });
  });

  it('does not retry a refusal that means the message is wrong', async () => {
    const { table, sends, deps } = setup([new Error('Twilio refused the message (HTTP 400)')], [{}]);
    await flushOutbox(deps);
    await flushOutbox(deps);
    expect(sends).toHaveLength(1);
    expect(table[0]?.status).toBe('failed');
  });

  it('closes an item a crash left in "sending", without sending it again', async () => {
    const { table, sends, deps } = setup([], [{ status: 'sending', claimed_at: '2026-10-26T11:50:00Z' }, { status: 'sending', claimed_at: '2026-10-26T11:59:00Z' }]);
    await flushOutbox(deps);
    expect(sends).toHaveLength(0);
    expect(table[0]).toMatchObject({ status: 'failed', body: 'Reply SEND <1-3> ••••••' });
    expect(table[1]?.status).toBe('sending'); // claimed a minute ago: maybe still in flight
  });

  it('never marks a delivered text failed when recording it fails', async () => {
    const { table, deps, failSettle } = setup(['SM-1'], [{}]);
    failSettle();
    await flushOutbox(deps);
    expect(table[0]?.status).toBe('sending'); // left for the stranded check, not 'failed'
  });
});
