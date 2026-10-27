import { randomUUID } from 'node:crypto';
import type { AssistantId, FrontDoorDecision, Metric, ProfitPlans } from '@fahq/contracts';
import { approveAction, BRIEF_CODE_FOR, divisionBrief, requestBriefs } from './brief.ts';
import { parseCommand, type Command } from './commands.ts';
import { approverOf, done, errorText, fail, fitSms, newCode, receipt, text, type Outcome, type WorkerDeps } from './common.ts';
import { departmentsFor, DEPARTMENT_LABEL, originsOf } from './departments.ts';
import { ceoDigest, currentDigest } from './digest.ts';
import { planDigest, PlanError, writePlans } from './finance.ts';
import { adoptChanges, askQuestion, managerReview, requestReview } from './manager.ts';
import { routeText } from './router.ts';
import { planRound } from './rounds.ts';
import { settleScreen, startScreen } from './screen.ts';
import type { MessageRow, PersonRow, TaskRow } from './store.ts';
import { requestWeeklyReports, weeklyReport } from './weekly.ts';
import { dailyWorker } from './workers.ts';

// The assistants' flows. Assistants send proposals; only a person's one-time code turns a proposal
// into a forward, a decision or an adopted lesson. Every step leaves a receipt.

export type { Outcome, WorkerDeps } from './common.ts';
export { fitSms } from './common.ts';

export async function handleTask(task: TaskRow, deps: WorkerDeps): Promise<Outcome> {
  const runId = randomUUID();
  if (task.kind === 'inbound_text') return inbound(task, deps, runId);
  if (task.kind === 'mailbox') return mailbox(task, deps, runId);
  if (task.kind === 'scheduled') return scheduled(task, deps, runId);
  return fail(`unsupported task kind ${task.kind}`);
}

async function scheduled(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const job = String((task.payload as { job?: unknown }).job ?? '');
  if (task.assistant_id === 'manager' && job === 'manager_review') return managerReview(task, deps, runId);
  if (job === 'division_brief') return divisionBrief(task, deps, runId);
  if (job === 'division_worker') return dailyWorker(task, deps, runId);
  if (job === 'weekly_report') return weeklyReport(task, deps, runId);
  if (task.assistant_id === 'owner' && job === 'ceo_digest') return ceoDigest(task, deps, runId);
  return fail(`unsupported scheduled job "${job}" for the ${task.assistant_id} assistant`);
}

async function inbound(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const payload = task.payload as { from?: string; body?: string; personId?: string };
  // The database resolved the sender when it queued the text (a shared phone resolves to the person
  // whose assistant number was texted); the phone must still match.
  const person = payload.personId ? await deps.store.person(payload.personId) : null;
  if (!person || person.phone !== payload.from || !payload.body) return fail('the sender is not registered or the text is empty');
  const command = parseCommand(payload.body);
  if (command) return handleCommand(command, person, task, deps, runId);
  return freeText(person, payload.body, task, deps, runId);
}

/**
 * A text that is not a command. The safety screen and the front door's router start together; if the
 * screen does not say safe, the router's answer is dropped and nothing starts. The finance owner's own
 * questions skip the router (department heads ask their own assistant) but not the screen.
 */
async function freeText(person: PersonRow, body: string, task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const started = deps.now();
  const screened = startScreen(deps, body);
  const ctx = { runId, task, person, started };
  if (person.assistant_id === 'finance') {
    return (await settleScreen(deps, ctx, await screened)) ?? askQuestion(person, 'finance', body, task, deps, runId);
  }
  const routing = routeText(deps.models.nvidia, deps.models.routerModel, body, person.assistant_id).then(
    (routed) => ({ routed }),
    (error: unknown) => ({ error: errorText(error, 'router failed') }),
  );
  const stopped = await settleScreen(deps, ctx, await screened);
  if (stopped) return stopped;
  const result = await routing;
  if ('error' in result) {
    await receipt(deps, { runId, taskId: task.id, step: 'front-door', assistant: person.assistant_id, started, outcome: 'failed', model: deps.models.routerModel, detail: result.error });
    await text(deps, person, person.assistant_id, "I couldn't reach the routing model just now, so nothing was started. Please try again in a minute.", `reply:${task.id}`);
    return fail(`front door failed: ${result.error}`);
  }
  const { routed } = result;
  await receipt(deps, {
    runId, taskId: task.id, step: 'front-door', assistant: person.assistant_id, started, model: routed.model,
    outcome: routed.valid ? 'ok' : 'refused', inputTokens: routed.inputTokens, outputTokens: routed.outputTokens,
    detail: `${routed.decision.intent} → ${routed.decision.targetAssistant}; risks: ${routed.decision.risks.join(',') || 'none'}; ${routed.decision.reason}`,
  });
  return person.role === 'owner'
    ? ownerText(person, body, routed.decision, task, deps, runId, started)
    : otherText(person, body, routed.decision, task, deps, runId, started);
}

/**
 * The owner's text, routed. Plans go to every department (or to the one named) and come back as three;
 * anything else is a question for the department that knows: Owner HQ for the owner's own, else the one named.
 */
async function ownerText(
  person: PersonRow, body: string, decision: FrontDoorDecision, task: TaskRow, deps: WorkerDeps, runId: string, started: Date,
): Promise<Outcome> {
  const target = decision.targetAssistant;
  if (decision.intent === 'plans') return startRound(person, body, target, task, deps, runId, started);
  const label = target === 'owner' ? undefined : target === 'manager' ? 'Manager' : DEPARTMENT_LABEL[target];
  return askQuestion(person, target, body, task, deps, runId, label);
}

/** Owner HQ asks each department for plans (one request each), and queues ONE round that collects them. */
async function startRound(
  person: PersonRow, body: string, target: AssistantId, task: TaskRow, deps: WorkerDeps, runId: string, started: Date,
): Promise<Outcome> {
  const departments = departmentsFor(target);
  for (const department of departments) {
    await deps.store.postMessage({
      from: 'owner', to: department, kind: 'request', replyTo: null, dedupeKey: `round:${task.id}:${department}`,
      body: { text: body, roundId: task.id, personId: person.id },
    });
    await deps.brain.record.request({
      taskId: task.id, personId: person.id, personName: person.name, from: 'owner', to: department, text: body, at: started.toISOString(), runId,
    });
  }
  await deps.store.enqueueTask({
    assistant: 'owner', kind: 'mailbox', key: `round:${task.id}`, payload: { job: 'plan_round', roundId: task.id, departments }, now: deps.now(),
  });
  await receipt(deps, { runId, taskId: task.id, step: 'owner.round', assistant: 'owner', started, outcome: 'ok', detail: `plans asked of ${departments.join(', ')}` });
  return done;
}

/**
 * A text from anyone but the owner. A request for plans that reaches the finance assistant is one finance
 * assistant's job (the proposal comes back to the sender). Anything else is a question for the sender's
 * OWN assistant, on its own reads: a department head is boss of her field and asks only her assistant.
 */
async function otherText(
  person: PersonRow, body: string, decision: FrontDoorDecision, task: TaskRow, deps: WorkerDeps, runId: string, started: Date,
): Promise<Outcome> {
  const { targetAssistant, intent } = decision;
  if (intent !== 'plans') return askQuestion(person, person.assistant_id, body, task, deps, runId);
  if (targetAssistant !== 'finance') {
    await text(deps, person, person.assistant_id, 'The owner asks the departments for plans. I can answer questions about your own numbers.', `reply:${task.id}`);
    return done;
  }
  const request = await deps.store.postMessage({
    from: person.assistant_id, to: 'finance', kind: 'request', replyTo: null, dedupeKey: `request:${task.id}`,
    body: { text: body, personId: person.id, risks: decision.risks, taskId: task.id },
  });
  await deps.brain.record.request({
    taskId: task.id, personId: person.id, personName: person.name, from: person.assistant_id, to: 'finance',
    text: body, at: started.toISOString(), runId,
  });
  await deps.store.enqueueTask({ assistant: 'finance', kind: 'mailbox', key: `mailbox:${request.id}`, payload: { messageId: request.id }, now: deps.now() });
  return done;
}

async function mailbox(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  if (task.assistant_id === 'owner' && (task.payload as { job?: unknown }).job === 'plan_round') return planRound(task, deps, runId);
  const messageId = String((task.payload as { messageId?: string }).messageId ?? '');
  const request = await deps.store.message(messageId);
  if (request.kind !== 'request' || request.to_assistant !== 'finance') return fail('mailbox item is not a finance request');
  const requester = await deps.store.personByAssistant(request.from_assistant);
  const askText = String(request.body.text ?? '');

  // A retry after the plans were stored reuses them: plans are never regenerated under a code that
  // may already be on the owner's phone.
  let proposal = await deps.store.messageByKey(`proposal:${request.id}`);
  if (!proposal) {
    if (!deps.data) {
      await text(deps, requester, 'finance', "Business data isn't connected yet, so I can't prepare plans. Nothing was sent.", `reply:${task.id}`);
      return fail('business data (packages/data) is not connected');
    }
    const started = deps.now();
    let result;
    try {
      result = await writePlans({
        model: deps.models.nvidia, planModel: deps.models.planModel, data: deps.data,
        memory: deps.brain.memory('finance'), now: started, request: askText, period: deps.period,
        // What the owner adopted for the finance assistant: standing guidance for the plan writer.
        lessons: deps.brain.memory('finance').lessons(10).map((m) => m.content),
      });
    } catch (error) {
      const detail = error instanceof PlanError ? error.objections.join(' | ') : error instanceof Error ? error.message : 'unknown error';
      await receipt(deps, { runId, taskId: task.id, step: 'finance.plans', assistant: 'finance', started, outcome: 'failed', model: deps.models.planModel, detail });
      await text(deps, requester, 'finance', "I couldn't produce plans whose numbers all check out, so I'm not sending any. The reasons are on the console.", `reply:${task.id}`);
      return fail(`plans not produced: ${detail}`);
    }
    const firstObjection = result.attempts > 1 ? result.firstObjections[0] : undefined;
    await receipt(deps, {
      runId, taskId: task.id, step: 'finance.plans', assistant: 'finance', started, outcome: 'ok', model: result.model,
      dataSource: `zetaris:${result.view}#${result.queryHash.slice(0, 12)}`,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      // The report's "needed a correction round" suggestion reads this line back.
      detail: `attempts ${result.attempts}, tokens ${result.tokens}, cited ${result.citedMetricIds.length} metrics${firstObjection ? `; first objection: ${firstObjection.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`,
    });
    const cited = result.metrics.filter((m) => result.citedMetricIds.includes(m.id));
    proposal = await deps.store.postMessage({
      from: 'finance', to: request.from_assistant, kind: 'proposal', replyTo: request.id, dedupeKey: `proposal:${request.id}`,
      body: { plans: result.plans, metrics: cited, queryHash: result.queryHash, view: result.view, model: result.model, declinedEchoes: result.declinedEchoes, requestText: askText },
    });
  }

  // Everything below reads the stored proposal, so a re-run repeats it exactly (each step is keyed).
  const plans = proposal.body.plans as ProfitPlans;
  const view = String(proposal.body.view ?? '');
  const queryHash = String(proposal.body.queryHash ?? '');
  const citedMetricIds = citedMetricsOf(proposal).map((m) => m.id);
  const declinedEchoes = (proposal.body.declinedEchoes as { rank: number }[] | undefined) ?? [];
  await deps.brain.record.proposal({
    proposalId: proposal.id, requestTaskId: String(request.body.taskId ?? request.id), by: 'finance', forPersonId: requester.id,
    titles: plans.plans.map((p) => p.title), citedMetricIds, dataSource: `zetaris:${queryHash}`,
    at: new Date(proposal.created_at).toISOString(), runId,
  });
  deps.brain.memory('finance').rememberProposal({ proposalId: proposal.id, summary: plans.plans.map((p) => `${p.rank}. ${p.title}`).join(' / '), runId });

  const financeOwner = await deps.store.personByAssistant('finance');
  const code = newCode();
  const echoes = declinedEchoes.length
    ? `\nNote: plan ${[...new Set(declinedEchoes.map((e) => e.rank))].join(', ')} resembles an idea that was declined before.`
    : '';
  await deps.store.issueApproval({
    messageId: proposal.id, personId: requester.id, action: 'forward_plan', code, from: 'finance', now: deps.now(),
    smsDedupeKey: `proposal-sms:${proposal.id}`,
    smsBody: fitSms(
      `Your finance assistant's 3 plans (every number checked against ${view}):\n${planDigest(plans, citedMetricsOf(proposal))}${echoes}`,
      `Reply SEND <1-3> ${code} to send one to ${financeOwner.name}. The code expires in 15 minutes.`,
    ),
  });
  await deps.store.addOutbox({ channel: 'print', toPersonId: requester.id, from: 'finance', body: 'Proposal printout', attachmentRef: `proposal:${proposal.id}`, dedupeKey: `proposal-print:${proposal.id}` });
  await deps.store.setMessageStatus(request.id, 'answered');
  return done;
}

async function handleCommand(command: Command, person: PersonRow, task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const reply = (body: string) => text(deps, person, person.assistant_id, body, `reply:${task.id}`);
  const started = deps.now();
  switch (command.kind) {
    case 'malformed':
      await reply(command.hint);
      return done;
    case 'status': {
      // The owner is the CEO division: STATUS is the company digest, built now from the reports that are in.
      // A division head keeps the count of her assistant's open items.
      await reply(person.role === 'owner' ? await currentDigest(deps) : `Open items for your assistant: ${await deps.store.openTaskCount(person.assistant_id)}.`);
      return done;
    }
    case 'send':
      return forwardPlan(command, person, task, deps, runId, started, reply);
    case 'confirm':
    case 'decline':
      return decidePlan(command, person, task, deps, runId, started, reply);
    case 'adopt':
      return adoptChanges(command, person, task, deps, runId, started, reply);
    case 'approve':
      return approveAction(command, person, task, deps, runId, started, reply);
    case 'review':
      return requestReview(person, task, deps, runId, started);
    case 'brief':
      return requestBriefs(person, task, deps, runId, started, reply);
    case 'report':
      return requestWeeklyReports(command, person, task, deps, runId, started, reply);
  }
}

async function forwardPlan(
  command: Extract<Command, { kind: 'send' }>, sender: PersonRow, task: TaskRow, deps: WorkerDeps,
  runId: string, started: Date, reply: (b: string) => Promise<void>,
): Promise<Outcome> {
  const used = await deps.store.useApprovalCode({
    phone: sender.phone, code: command.code, verdict: 'signed', action: 'forward_plan', taskId: task.id,
    detail: { planRank: command.planRank }, now: started,
  });
  if (used.outcome === 'wrong_action') {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.forward', assistant: sender.assistant_id, started, outcome: 'refused', detail: `code is for ${used.action ?? 'another action'}` });
    await reply(used.action === 'adopt_change'
      ? 'That code is for adopting a review recommendation: reply ADOPT <1-3> <code>. Nothing was sent.'
      : used.action === 'approve_action'
        ? `That code is for ${BRIEF_CODE_FOR}. Nothing was sent.`
        : `That code is for a decision: reply CONFIRM <code> or DECLINE <code>. Nothing was sent.`);
    return done;
  }
  if (used.outcome !== 'signed' || used.action !== 'forward_plan' || !used.message_id) {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.forward', assistant: sender.assistant_id, started, outcome: 'refused', detail: 'code refused' });
    await reply("That code didn't work or has expired. Nothing was sent.");
    return done;
  }
  // The code acts as the person it was issued to (on a shared phone, not necessarily the texted assistant's).
  const { person, answer } = await approverOf(used.approver_person_id, sender, task, deps);
  const proposal = await deps.store.message(used.message_id);
  const plan = (proposal.body.plans as ProfitPlans).plans.find((p) => p.rank === command.planRank);
  if (!plan) return fail('plan rank not found on the proposal');
  const financeOwner = await deps.store.personByAssistant('finance');
  const forward = await deps.store.postMessage({
    from: person.assistant_id, to: 'finance', kind: 'request', replyTo: proposal.id,
    dedupeKey: `forward:${proposal.id}:${command.planRank}`,
    body: { proposalId: proposal.id, planRank: command.planRank, forwardedBy: person.id },
  });
  const code = newCode();
  const origin = originsOf(proposal.body).find((o) => o.rank === plan.rank);
  await deps.store.issueApproval({
    messageId: forward.id, personId: financeOwner.id, action: 'decide_plan', code, from: 'finance', now: deps.now(),
    smsDedupeKey: `forward-sms:${forward.id}`,
    smsBody: fitSms(
      `${person.name} sent you plan ${plan.rank}: ${plan.title}${origin ? `\nFrom the ${DEPARTMENT_LABEL[origin.department]} department.` : ''}\n${plan.summary}\nTest: ${plan.test}\nStop-loss: ${plan.stopLoss}`,
      `Reply CONFIRM ${code} or DECLINE ${code}. The code expires in 15 minutes.`,
    ),
  });
  await deps.store.addOutbox({ channel: 'print', toPersonId: financeOwner.id, from: 'finance', body: `Plan ${plan.rank} for decision`, attachmentRef: `proposal:${proposal.id}`, dedupeKey: `forward-print:${forward.id}` });
  await deps.brain.record.decision({ proposalId: proposal.id, personId: person.id, personName: person.name, verdict: 'signed', planRank: plan.rank, action: 'forward_plan', at: deps.now().toISOString(), runId });
  await receipt(deps, { runId, taskId: task.id, step: 'approval.forward', assistant: person.assistant_id, started, outcome: 'ok', detail: `plan ${plan.rank} forwarded to ${financeOwner.id}` });
  await answer(`Sent plan ${plan.rank} to ${financeOwner.name}.`);
  return done;
}

async function decidePlan(
  command: Extract<Command, { kind: 'confirm' | 'decline' }>, sender: PersonRow, task: TaskRow, deps: WorkerDeps,
  runId: string, started: Date, reply: (b: string) => Promise<void>,
): Promise<Outcome> {
  const verdict = command.kind === 'confirm' ? 'signed' : 'declined';
  const used = await deps.store.useApprovalCode({
    phone: sender.phone, code: command.code, verdict, action: 'decide_plan', taskId: task.id, detail: {}, now: started,
  });
  if (used.outcome === 'wrong_action') {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.decide', assistant: sender.assistant_id, started, outcome: 'refused', detail: `code is for ${used.action ?? 'another action'}` });
    await reply(used.action === 'adopt_change'
      ? 'That code is for adopting a review recommendation: reply ADOPT <1-3> <code>. Nothing was recorded.'
      : used.action === 'approve_action'
        ? `That code is for ${BRIEF_CODE_FOR}. Nothing was recorded.`
        : `That code is for sending a plan: reply SEND <1-3> <code>. Nothing was recorded.`);
    return done;
  }
  if (used.outcome !== verdict || used.action !== 'decide_plan' || !used.message_id) {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.decide', assistant: sender.assistant_id, started, outcome: 'refused', detail: 'code refused' });
    await reply("That code didn't work or has expired. Nothing was recorded.");
    return done;
  }
  const { person, answer } = await approverOf(used.approver_person_id, sender, task, deps);
  const forward: MessageRow = await deps.store.message(used.message_id);
  const proposalId = String(forward.body.proposalId ?? '');
  const planRank = Number(forward.body.planRank ?? 0);
  const proposal = await deps.store.message(proposalId);
  const plan = (proposal.body.plans as ProfitPlans).plans.find((p) => p.rank === planRank);
  const owner = await deps.store.person(String(forward.body.forwardedBy ?? ''));
  const word = verdict === 'signed' ? 'approved' : 'declined';
  const stamp = { at: deps.now().toISOString(), runId };

  await deps.brain.record.decision({ proposalId, personId: person.id, personName: person.name, verdict, planRank, action: 'decide_plan', ...stamp });
  // Finance decides the plan; the department that wrote it remembers the decision too (keyed to its own
  // proposal, so the unapproved memory of it is settled). A plan finance wrote itself is remembered once.
  const origin = originsOf(proposal.body).find((o) => o.rank === planRank);
  const places = new Map<AssistantId, { proposalId: string; planRank: number }>([['finance', { proposalId, planRank }]]);
  if (origin) places.set(origin.department, { proposalId: origin.proposalId, planRank: origin.originalRank });
  for (const [assistant, where] of places) {
    deps.brain.memory(assistant).rememberDecision({ ...where, personId: person.id, verdict, planTitle: plan?.title ?? `plan ${planRank}`, runId });
  }
  await deps.store.postMessage({ from: 'finance', to: owner.assistant_id, kind: 'decision', replyTo: forward.id, dedupeKey: `decision:${forward.id}`, body: { proposalId, planRank, verdict, by: person.id } });
  await text(deps, owner, 'finance', `${person.name} ${word} plan ${planRank}: ${plan?.title ?? ''}`.trim(), `decision-sms:${forward.id}`);
  await receipt(deps, { runId, taskId: task.id, step: 'approval.decide', assistant: 'finance', started, outcome: 'ok', detail: `plan ${planRank} ${word} by ${person.id}` });
  await answer(`Recorded: you ${word} plan ${planRank}. Thank you.`);
  return done;
}

export function citedMetricsOf(proposal: MessageRow): Metric[] {
  return (proposal.body.metrics as Metric[] | undefined) ?? [];
}
