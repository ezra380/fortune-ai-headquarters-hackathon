import { checkPlans, type Metric, type ProfitPlans } from '@fahq/contracts';
import { done, errorText, fail, fitSms, newCode, receipt, text, type Outcome, type WorkerDeps } from './common.ts';
import { DEPARTMENT_LABEL, isDepartment, originsOf, type Department, type Origin } from './departments.ts';
import { PlanError, planLine, writePlans, type PlanResult } from './finance.ts';
import type { MessageRow, PersonRow, TaskRow } from './store.ts';
import { candidateId, pickByRule, synthesize, type Candidate, type Picked } from './synthesis.ts';

// A round of plans. The owner asked for plans, so every department proposes from its OWN data, in
// parallel, and Owner HQ hands the owner the best three. Each step is keyed by the round, so a task that
// runs again reuses what is stored instead of asking a model twice or sending a second code.
//
//   request  → one 'request' per department (round:<id>:<dept>)           [posted by the front door]
//   proposal → one 'proposal' per department that passed its number check (proposal:<id>:<dept>)
//   report   → one 'report' per department that could not (round-failed:<id>:<dept>)
//   final    → Owner HQ's three picks (final:<id>), then the code that lets the owner send one on

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const sourceTag = (view: string, queryHash: string) => `zetaris:${view}#${queryHash.slice(0, 12)}`;

type Source = { metrics: Metric[]; queryHash: string; view: string };
type Round = { task: TaskRow; deps: WorkerDeps; runId: string; roundId: string; owner: PersonRow; requestText: string; source: Source };
type Answered = { ok: true; department: Department; proposal: MessageRow; plans: ProfitPlans; echoes: { rank: number; memoryId: string }[] };
type Unanswered = { ok: false; department: Department; reason: string };
type Result = Answered | Unanswered;

export async function planRound(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const payload = task.payload as { roundId?: unknown; departments?: unknown };
  const roundId = typeof payload.roundId === 'string' ? payload.roundId : '';
  const departments = [...new Set(list<unknown>(payload.departments))].filter(isDepartment);
  if (!roundId || departments.length === 0) return fail('the plan round has no departments to ask');
  const requests = await Promise.all(departments.map((d) => deps.store.messageByKey(`round:${roundId}:${d}`)));
  const first = requests.find((r): r is MessageRow => r !== null);
  if (!first || requests.some((r) => r === null)) return fail('a department request of the round is missing');
  const owner = await deps.store.person(String(first.body.personId ?? ''));
  const tell = (body: string, key: string) => text(deps, owner, 'owner', body, `${key}:${roundId}`);

  // A round that was already put together is only announced again (its approval and texts are keyed).
  const existing = await deps.store.messageByKey(`final:${roundId}`);
  if (existing) return announce({ deps, runId, roundId, owner }, existing, departments);

  if (!deps.data) {
    await tell("Business data isn't connected yet, so I can't prepare plans. Nothing was sent.", 'round-failed-sms');
    return fail('business data (packages/data) is not connected');
  }
  const started = deps.now();
  let source: Source;
  try {
    const read = await deps.data.getFinanceMetrics({ asOf: started.toISOString(), period: deps.period });
    source = { metrics: read.metrics, queryHash: read.queryHash, view: read.view };
  } catch (error) {
    const detail = errorText(error, 'the business data could not be read');
    await receipt(deps, { runId, taskId: task.id, step: 'owner.data', assistant: 'owner', started, outcome: 'failed', detail });
    await tell("I couldn't read the business data just now, so no department could plan. Nothing was sent.", 'round-failed-sms');
    return fail(`the business data could not be read: ${detail}`);
  }
  const round: Round = { task, deps, runId, roundId, owner, requestText: String(first.body.text ?? ''), source };

  // Every department plans at the same time. A department's own failure is a result; a failure of ours (the
  // database) is thrown so the whole task runs again, and the stored proposals are reused.
  const settled = await Promise.allSettled(departments.map((d, i) => runDepartment(round, d, requests[i]!)));
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  const results = settled.map((s) => (s as PromiseFulfilledResult<Result>).value);
  const answered = results.filter((r): r is Answered => r.ok);
  const failed = results.filter((r): r is Unanswered => !r.ok);
  if (answered.length === 0) {
    await tell("I couldn't get plans whose numbers all check out from any department, so I'm not sending any. The reasons are on the console.", 'round-failed-sms');
    return fail(`no department produced checked plans: ${failed.map((f) => `${f.department}: ${clip(f.reason, 120)}`).join(' | ')}`);
  }

  const chosen = await choose(round, answered);
  const finalPlans = assemble(chosen.picks, chosen.candidates);
  const check = checkPlans(finalPlans, source.metrics);
  if (!check.ok) {
    await receipt(deps, { runId, taskId: task.id, step: 'owner.final', assistant: 'owner', started: deps.now(), outcome: 'failed', detail: check.errors.slice(0, 3).join(' | ') });
    await tell("The plans I picked didn't pass their final number check, so I'm not sending any.", 'round-failed-sms');
    return fail(`the final plans did not pass the number check: ${check.errors.slice(0, 3).join(' | ')}`);
  }

  const final = await postFinal(round, { answered, failed, chosen, plans: finalPlans, cited: new Set(check.citedMetricIds) });
  return announce(round, final, departments);
}

/** Stores Owner HQ's three picks as the final proposal (keyed by the round) and records the step. */
async function postFinal(
  round: Round,
  input: { answered: readonly Answered[]; failed: readonly Unanswered[]; chosen: Chosen; plans: ProfitPlans; cited: ReadonlySet<string> },
): Promise<MessageRow> {
  const { deps, task, runId, roundId, source } = round;
  const { answered, failed, chosen } = input;
  const origins: Origin[] = chosen.picks.map((p, i) => {
    const c = chosen.candidates.find((x) => x.id === p.id)!;
    return { rank: i + 1, department: c.department, originalRank: c.plan.rank, proposalId: c.proposalId };
  });
  // A plan that resembles a declined idea keeps that warning under its new rank.
  const declinedEchoes = origins.flatMap((o) =>
    (answered.find((a) => a.department === o.department)?.echoes ?? []).filter((e) => e.rank === o.originalRank).map((e) => ({ rank: o.rank, memoryId: e.memoryId, department: o.department })));
  const final = await deps.store.postMessage({
    from: 'owner', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: `final:${roundId}`,
    body: {
      plans: input.plans, metrics: source.metrics.filter((m) => input.cited.has(m.id)), origins,
      why: chosen.picks.flatMap((p, i) => (p.why ? [{ rank: i + 1, text: p.why }] : [])), note: chosen.note, pickedBy: chosen.pickedBy,
      view: source.view, queryHash: source.queryHash, requestText: round.requestText,
      departments: answered.map((a) => a.department), failedDepartments: failed.map((f) => f.department), declinedEchoes,
    },
  });
  await receipt(deps, {
    runId, taskId: task.id, step: 'owner.final', assistant: 'owner', started: deps.now(), outcome: 'ok', dataSource: sourceTag(source.view, source.queryHash),
    detail: `3 plans from ${[...new Set(origins.map((o) => o.department))].join(', ')}; picked by ${chosen.pickedBy}${failed.length ? `; no checked plans from ${failed.map((f) => f.department).join(', ')}` : ''}`,
  });
  return final;
}

// ---- One department -------------------------------------------------------------------------------

async function runDepartment(round: Round, department: Department, request: MessageRow): Promise<Result> {
  const { deps, task, runId, roundId, source } = round;
  const stored = await deps.store.messageByKey(`proposal:${roundId}:${department}`);
  if (stored) return remember(round, department, stored);
  // A department that already failed this round is not asked again: its reasons are on its report.
  const failedBefore = await deps.store.messageByKey(`round-failed:${roundId}:${department}`);
  if (failedBefore) return { ok: false, department, reason: String(failedBefore.body.reason ?? 'it failed earlier in this round') };

  const started = deps.now();
  const memory = deps.brain.memory(department);
  let result: PlanResult;
  try {
    result = await writePlans({
      model: deps.models.nvidia, planModel: deps.models.planModel, department, source, memory, now: started,
      request: round.requestText, period: deps.period, lessons: memory.lessons(10).map((m) => m.content),
    });
  } catch (error) {
    // A department that cannot produce checked plans says so; the others carry on.
    const reason = error instanceof PlanError ? error.objections.join(' | ') : errorText(error, 'the plan writer failed');
    const usage = error instanceof PlanError ? error.usage : { inputTokens: undefined, outputTokens: undefined };
    await receipt(deps, { runId, taskId: task.id, step: `${department}.plans`, assistant: department, started, outcome: 'failed', model: deps.models.planModel, ...usage, detail: reason });
    await deps.store.postMessage({
      from: department, to: 'owner', kind: 'report', replyTo: request.id, dedupeKey: `round-failed:${roundId}:${department}`,
      body: { roundId, failed: true, reason: clip(reason, 500) },
    });
    return { ok: false, department, reason };
  }
  const firstObjection = result.attempts > 1 ? result.firstObjections[0] : undefined;
  await receipt(deps, {
    runId, taskId: task.id, step: `${department}.plans`, assistant: department, started, outcome: 'ok', model: result.model,
    dataSource: sourceTag(result.view, result.queryHash), inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    // The report's "needed a correction round" suggestion reads this line back.
    detail: `attempts ${result.attempts}, tokens ${result.tokens}, cited ${result.citedMetricIds.length} metrics${firstObjection ? `; first objection: ${firstObjection.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`,
  });
  const proposal = await deps.store.postMessage({
    from: department, to: 'owner', kind: 'proposal', replyTo: request.id, dedupeKey: `proposal:${roundId}:${department}`,
    body: {
      plans: result.plans, metrics: result.metrics.filter((m) => result.citedMetricIds.includes(m.id)), queryHash: result.queryHash,
      view: result.view, model: result.model, declinedEchoes: result.declinedEchoes, requestText: round.requestText, roundId, department,
    },
  });
  return remember(round, department, proposal);
}

/** What a stored department proposal adds to the shared record and to that department's own memory (both keyed). */
async function remember(round: Round, department: Department, proposal: MessageRow): Promise<Answered> {
  const { deps, runId, roundId, owner } = round;
  const plans = proposal.body.plans as ProfitPlans;
  const citedMetricIds = list<Metric>(proposal.body.metrics).map((m) => m.id);
  await deps.brain.record.proposal({
    proposalId: proposal.id, requestTaskId: roundId, by: department, forPersonId: owner.id, titles: plans.plans.map((p) => p.title),
    citedMetricIds, dataSource: `zetaris:${String(proposal.body.queryHash ?? '')}`, at: new Date(proposal.created_at).toISOString(), runId,
  });
  deps.brain.memory(department).rememberProposal({ proposalId: proposal.id, summary: plans.plans.map((p) => `${p.rank}. ${p.title}`).join(' / '), runId });
  return { ok: true, department, proposal, plans, echoes: list<{ rank: number; memoryId: string }>(proposal.body.declinedEchoes) };
}

// ---- Choosing the three ----------------------------------------------------------------------------

type Chosen = { picks: Picked[]; note: string; pickedBy: 'model' | 'rule'; candidates: Candidate[] };

/** One department: its own three. Several: Owner HQ's model picks (checked), or a rule does and says so. */
async function choose(round: Round, answered: readonly Answered[]): Promise<Chosen> {
  const { deps, task, runId } = round;
  const candidates: Candidate[] = answered.flatMap((a) =>
    a.plans.plans.map((plan) => ({ id: candidateId(a.department, plan.rank), department: a.department, plan, proposalId: a.proposal.id })));
  if (answered.length === 1) {
    const own = candidates.slice().sort((a, b) => a.plan.rank - b.plan.rank);
    return { picks: own.map((c) => ({ id: c.id, why: '' })), note: '', pickedBy: 'rule', candidates };
  }
  const started = deps.now();
  const written = await synthesize({
    model: deps.models.nvidia, planModel: deps.models.planModel, request: round.requestText, candidates, metrics: round.source.metrics,
    lessons: deps.brain.memory('owner').lessons(10).map((m) => m.content),
  });
  const base = { runId, taskId: task.id, step: 'owner.synthesis', assistant: 'owner' as const, started, model: written.model, inputTokens: written.inputTokens, outputTokens: written.outputTokens };
  if (written.ok) {
    await receipt(deps, {
      ...base, outcome: 'ok',
      detail: `attempts ${written.attempts}, ${candidates.length} candidates${written.attempts > 1 && written.firstObjection ? `; first objection: ${clip(written.firstObjection.replace(/\s+/g, ' '), 200)}` : ''}`,
    });
    return { picks: written.picks, note: written.note, pickedBy: 'model', candidates };
  }
  await receipt(deps, { ...base, outcome: written.why === 'model' ? 'failed' : 'refused', detail: `attempts ${written.attempts}; picked by rule; ${clip(written.reason, 300)}` });
  return { picks: pickByRule(candidates), note: '', pickedBy: 'rule', candidates };
}

/** The picked plans, re-ranked 1 to 3 in the order picked; nothing else about them changes. */
function assemble(picks: readonly Picked[], candidates: readonly Candidate[]): ProfitPlans {
  return { plans: picks.map((p, i) => ({ ...candidates.find((c) => c.id === p.id)!.plan, rank: i + 1 })), memoryConflicts: [] };
}

// ---- Telling the owner -------------------------------------------------------------------------------

/** The owner's text: the three plans with their departments, a reason each when it fits, and the SEND tail. */
export function finalSms(body: Record<string, unknown>, financeOwnerName: string, code: string): string {
  const plans = (body.plans as ProfitPlans).plans.slice().sort((a, b) => a.rank - b.rank);
  const metrics = list<Metric>(body.metrics);
  const origins = originsOf(body);
  const whys = new Map(list<{ rank: number; text: string }>(body.why).map((w) => [w.rank, w.text]));
  const byRule = body.pickedBy === 'rule' && list(body.departments).length > 1;
  const echoes = [...new Set(list<{ rank: number }>(body.declinedEchoes).map((e) => e.rank))];
  const names = list<Department>(body.failedDepartments).map((d) => DEPARTMENT_LABEL[d]);
  const head = (withWhy: boolean) => [
    `Your departments' best 3 plans (${byRule ? 'picked by rule; ' : ''}every number checked against ${String(body.view ?? '')}):`,
    ...plans.flatMap((p) => [planLine(p, metrics, origins.find((o) => o.rank === p.rank)), ...(withWhy && whys.get(p.rank) ? [`Why: ${whys.get(p.rank)}`] : [])]),
    ...(echoes.length ? [`Note: plan ${echoes.join(', ')} resembles an idea that was declined before.`] : []),
    ...(names.length ? [`${names.join(' and ')} couldn't produce checked plans.`] : []),
  ].join('\n');
  const tail = `Reply SEND <1-3> ${code} to send one to ${financeOwnerName}. The code expires in 15 minutes.`;
  const full = head(true);
  return fitSms(full.length + 1 + tail.length <= 1600 ? full : head(false), tail);
}

/** Records the final proposal, issues the code that lets the owner send one plan on, and queues the printout. */
async function announce(round: Pick<Round, 'deps' | 'runId' | 'roundId' | 'owner'>, final: MessageRow, departments: readonly Department[]): Promise<Outcome> {
  const { deps, runId, roundId, owner } = round;
  const plans = final.body.plans as ProfitPlans;
  await deps.brain.record.proposal({
    proposalId: final.id, requestTaskId: roundId, by: 'owner', forPersonId: owner.id, titles: plans.plans.map((p) => p.title),
    citedMetricIds: list<Metric>(final.body.metrics).map((m) => m.id), dataSource: `zetaris:${String(final.body.queryHash ?? '')}`,
    at: new Date(final.created_at).toISOString(), runId,
  });
  const financeOwner = await deps.store.personByAssistant('finance');
  const code = newCode();
  await deps.store.issueApproval({
    messageId: final.id, personId: owner.id, action: 'forward_plan', code, from: 'owner', now: deps.now(),
    smsDedupeKey: `proposal-sms:${final.id}`, smsBody: finalSms(final.body, financeOwner.name, code),
  });
  await deps.store.addOutbox({ channel: 'print', toPersonId: owner.id, from: 'owner', body: 'Proposal printout', attachmentRef: `proposal:${final.id}`, dedupeKey: `proposal-print:${final.id}` });
  for (const d of departments) {
    const answered = await deps.store.messageByKey(`proposal:${roundId}:${d}`);
    const request = await deps.store.messageByKey(`round:${roundId}:${d}`);
    if (request) await deps.store.setMessageStatus(request.id, answered ? 'answered' : 'closed');
  }
  return done;
}
