import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkReport } from '@fahq/contracts';
import type { WorkerDeps } from '../src/flows.ts';
import { runOnce } from '../src/runner.ts';
import type { TaskRow } from '../src/store.ts';

// FAKES: an in-memory store and brain, to pin down what the runner reports for each way a task ends.

const TASK_ID = '12345678-1234-4234-8234-123456789abc';
const person = { id: 'demo-p-owner', name: 'Demo Owner', role: 'owner', phone: '+15550111001', assistant_id: 'owner' as const };

function setup(task: Partial<TaskRow>, opts: { leaseLost?: boolean; saveFails?: boolean; recordFails?: boolean } = {}) {
  const finished: { status: string; error: string | null }[] = [];
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
    person: async () => person,
    openTaskCount: async () => 2,
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
  const deps = { store, brain, now: () => new Date('2026-10-26T12:00:00.000Z'), worker: 'w' } as unknown as WorkerDeps;
  return { deps, finished, reports, recorded };
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
