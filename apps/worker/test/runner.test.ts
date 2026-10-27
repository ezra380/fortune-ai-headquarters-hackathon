import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkReport } from '@fahq/contracts';
import type { WorkerDeps } from '../src/flows.ts';
import { runConcurrently, runOnce } from '../src/runner.ts';
import type { TaskRow } from '../src/store.ts';

// FAKES: an in-memory store and brain, to pin down what the runner reports for each way a task ends.

const TASK_ID = '12345678-1234-4234-8234-123456789abc';
// Not the owner: the owner's STATUS is the company digest, a division head's is the count of her assistant's open items (what these tests hold).
const person = { id: 'demo-p-owner', name: 'Demo Owner', role: 'finance_owner', phone: '+15550111001', assistant_id: 'owner' as const };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Setup = {
  leaseLost?: boolean; saveFails?: boolean; recordFails?: boolean;
  /** How often the lease is renewed, and how long the handler (the STATUS reply) is held: until this many renewals were
   *  asked for (2 s at most), then `thenMs` longer, to show that no more are asked for afterwards. */
  renewMs?: number; heldUntilRenewals?: number; thenMs?: number;
  /** What each renewal answers, in order (the last answer repeats): true = still held, false = lost, Error = thrown. */
  renewals?: (boolean | Error)[];
};

function setup(task: Partial<TaskRow>, opts: Setup = {}) {
  const finished: { status: string; error: string | null }[] = [];
  const renewed: { id: string; worker: string }[] = [];
  const reports: WorkReport[] = [];
  const recorded: { taskId: string; outcome: string }[] = [];
  const row: TaskRow = { id: TASK_ID, assistant_id: 'owner', kind: 'inbound_text', status: 'running', payload: {}, attempts: 1, max_attempts: 3, ...task };
  const store = {
    claimTask: async () => row,
    finishTask: async (_id: string, _worker: string, status: string, error: string | null) => {
      finished.push({ status, error });
      return !opts.leaseLost;
    },
    saveWorkReport: async (r: WorkReport) => {
      if (opts.saveFails) throw new Error('database down');
      reports.push(r);
    },
    extendLease: async (id: string, worker: string) => {
      renewed.push({ id, worker });
      const answers = opts.renewals ?? [true];
      const answer = answers[Math.min(renewed.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    person: async () => person,
    openTaskCount: async () => {
      for (let waited = 0; opts.heldUntilRenewals && renewed.length < opts.heldUntilRenewals && waited < 2000; waited += 2) await sleep(2);
      if (opts.thenMs) await sleep(opts.thenMs);
      return 2;
    },
    addOutbox: async () => {},
    message: async () => { throw new Error('message lookup failed'); },
    receipt: async () => {},
    strandedOutbox: async () => [],
    pendingOutbox: async () => [],
    registeredPhones: async () => new Set<string>(),
  };
  const brain = {
    record: {
      report: async (r: { taskId: string; outcome: string }) => {
        if (opts.recordFails) throw new Error('world model down');
        recorded.push(r);
      },
    },
  };
  const deps = { store, brain, now: () => new Date('2026-10-26T12:00:00.000Z'), worker: 'w', leaseRenewMs: opts.renewMs } as unknown as WorkerDeps;
  return { deps, finished, reports, recorded, renewed };
}

const statusText = { payload: { personId: 'demo-p-owner', from: '+15550111001', body: 'STATUS' } };
const spy = () => vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

describe('runOnce: the end-of-work report', () => {
  it('reports a finished task as done, and adds it to the shared record', async () => {
    const { deps, finished, reports, recorded } = setup(statusText);
    expect(await runOnce(deps)).toBe(true);
    expect(finished).toEqual([{ status: 'done', error: null }]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ taskId: TASK_ID, assistant: 'owner', taskKind: 'inbound_text', outcome: 'done', suggestions: [] });
    expect(recorded).toEqual([expect.objectContaining({ taskId: TASK_ID, outcome: 'done' })]);
  });

  it('reports a failed task with its reason as a suggestion', async () => {
    const { deps, finished, reports } = setup({ kind: 'scheduled', payload: { job: 'nothing' } });
    await runOnce(deps);
    expect(finished[0]?.status).toBe('failed');
    expect(reports[0]).toMatchObject({ outcome: 'failed', taskKind: 'scheduled' });
    expect(reports[0]!.suggestions).toEqual([{ kind: 'reliability', about: 'owner', text: expect.stringContaining('unsupported scheduled job "nothing"') }]);
  });

  it('reports a task queued again after an error as retrying, and a last attempt as failed', async () => {
    spy();
    const retry = setup({ kind: 'mailbox', assistant_id: 'finance', payload: { messageId: 'x' }, attempts: 1, max_attempts: 3 });
    await runOnce(retry.deps);
    expect(retry.finished[0]).toEqual({ status: 'queued', error: 'message lookup failed' });
    expect(retry.reports[0]).toMatchObject({ outcome: 'retrying', assistant: 'finance' });
    expect(retry.reports[0]!.summary).toContain('will retry');

    const last = setup({ kind: 'mailbox', assistant_id: 'finance', payload: { messageId: 'x' }, attempts: 3, max_attempts: 3 });
    await runOnce(last.deps);
    expect(last.finished[0]?.status).toBe('failed');
    expect(last.reports[0]?.outcome).toBe('failed');
  });

  it('logs a report that cannot be saved and never changes what happened to the task', async () => {
    const error = spy();
    const { deps, finished, reports } = setup(statusText, { saveFails: true });
    expect(await runOnce(deps)).toBe(true);
    expect(finished).toEqual([{ status: 'done', error: null }]);
    expect(reports).toHaveLength(0);
    expect(error).toHaveBeenCalledWith('worker.report_failed 12345678');
    expect(JSON.stringify(error.mock.calls)).not.toContain('database down'); // a code, not the reason or any data
  });

  it('logs a record that cannot be written the same way', async () => {
    const error = spy();
    const { deps, finished, reports } = setup(statusText, { recordFails: true });
    await runOnce(deps);
    expect(finished[0]?.status).toBe('done');
    expect(reports).toHaveLength(1); // the report row was saved before the record failed
    expect(error).toHaveBeenCalledWith('worker.report_failed 12345678');
  });

  it('writes no report when the lease was lost: the other worker owns the task now', async () => {
    const { deps, reports, recorded } = setup(statusText, { leaseLost: true });
    await runOnce(deps);
    expect(reports).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
});

describe('runOnce: the lease of the task being handled', () => {
  it('renews it while the task is handled, as the worker that holds it, and stops when the task ends', async () => {
    const { deps, finished, renewed } = setup(statusText, { renewMs: 5, heldUntilRenewals: 3 });
    await runOnce(deps);
    expect(finished).toEqual([{ status: 'done', error: null }]);
    expect(renewed.length).toBeGreaterThanOrEqual(3);
    expect(renewed.every((r) => r.id === TASK_ID && r.worker === 'w')).toBe(true);
    const count = renewed.length;
    await sleep(60);
    expect(renewed).toHaveLength(count); // nothing renews a task that is over
  });

  it('does not renew a task that is done before the first renewal is due', async () => {
    const { deps, renewed } = setup(statusText, { renewMs: 10_000 });
    await runOnce(deps);
    expect(renewed).toEqual([]);
  });

  it('stops asking, and says so once, when the lease is lost; the task still ends the way it ended', async () => {
    const error = spy();
    const { deps, finished, renewed } = setup(statusText, { renewMs: 5, heldUntilRenewals: 2, thenMs: 60, renewals: [true, false] });
    await runOnce(deps);
    expect(renewed).toHaveLength(2); // the second answer was "lost": no more asking
    expect(error.mock.calls.filter((c) => c[0] === 'worker.lease_lost 12345678')).toHaveLength(1);
    expect(finished).toEqual([{ status: 'done', error: null }]);
  });

  it('goes on asking after a renewal fails, and logs a code, not the reason', async () => {
    const error = spy();
    const { deps, finished, renewed } = setup(statusText, { renewMs: 5, heldUntilRenewals: 3, renewals: [new Error('database down'), true] });
    await runOnce(deps);
    expect(renewed.length).toBeGreaterThanOrEqual(3);
    expect(error).toHaveBeenCalledWith('worker.lease_renew_failed 12345678');
    expect(JSON.stringify(error.mock.calls)).not.toContain('database down');
    expect(finished).toEqual([{ status: 'done', error: null }]);
  });
});

describe('runConcurrently: one worker id per claim loop', () => {
  it('claims and finishes each task under the id of its own loop, and no two loops share one', async () => {
    const { deps } = setup(statusText);
    const claimedBy = new Map<string, string>();
    const ids = new Set<string>();
    let handed = 0;
    const queue = Array.from({ length: 6 }, (_, i): TaskRow => ({
      id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`, assistant_id: 'owner', kind: 'inbound_text', status: 'running',
      payload: statusText.payload, attempts: 1, max_attempts: 3,
    }));
    const wrapped = {
      ...deps,
      store: {
        ...deps.store,
        claimTask: async (worker: string) => {
          ids.add(worker);
          await sleep(5); // the loops overlap
          const task = queue[handed++] ?? null;
          if (task) claimedBy.set(task.id, worker);
          return task;
        },
        finishTask: async (id: string, worker: string) => { expect(worker).toBe(claimedBy.get(id)); return true; },
      },
    } as unknown as WorkerDeps;
    await runConcurrently(wrapped, 3, () => false, { untilIdle: true });
    expect([...ids].sort()).toEqual(['w#1', 'w#2', 'w#3']);
    expect(claimedBy.size).toBe(6);
    expect(new Set(claimedBy.values()).size).toBeGreaterThan(1);
  });
});
