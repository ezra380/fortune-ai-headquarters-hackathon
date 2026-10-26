import { randomInt, randomUUID } from 'node:crypto';
import type { AssistantId, DataPort, DeliveryPort, Metric, ModelPort, ProfitPlans } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { parseCommand, type Command } from './commands.ts';
import { planDigest, PlanError, writePlans } from './finance.ts';
import { routeText } from './router.ts';
import type { MessageRow, PersonRow, Store, TaskRow } from './store.ts';

// The assistants' flows. Assistants send proposals; only a person's one-time code turns a proposal
// into a forward or a decision. Every step leaves a receipt.

export type WorkerDeps = {
  store: Store;
  brain: Brain;
  models: { nvidia: ModelPort; planModel: string; routerModel: string };
  data: DataPort | null;
  delivery: DeliveryPort | null;
  now: () => Date;
  worker: string;
  /** true when talking to real providers; recorded on every receipt. */
  live: boolean;
  period: '2026-09' | '2026-10-mtd';
  smsLive: boolean;
  printers: Partial<Record<AssistantId, string>>;
  printDir: string;
  /** Dry-run SMS go here (and to the console) instead of Twilio. */
  smsSink?: (message: { to: string; body: string }) => void;
};

export type Outcome = { status: 'done' | 'failed'; error?: string };

const newCode = () => String(randomInt(100000, 1000000));
const done: Outcome = { status: 'done' };
const fail = (error: string): Outcome => ({ status: 'failed', error });

async function receipt(
  deps: WorkerDeps,
  r: { runId: string; taskId: string | null; step: string; assistant: AssistantId | null; started: Date; outcome: 'ok' | 'refused' | 'failed'; model?: string; dataSource?: string; detail?: string },
) {
  await deps.store.receipt({
    runId: r.runId, taskId: r.taskId, step: r.step, assistantId: r.assistant, live: deps.live,
    model: r.model ?? null, dataSource: r.dataSource ?? null, startedAt: r.started.toISOString(),
    endedAt: deps.now().toISOString(), costUsd: null, outcome: r.outcome, detail: r.detail?.slice(0, 500) ?? null,
  });
}

async function text(deps: WorkerDeps, to: PersonRow, from: AssistantId, body: string, dedupeKey: string) {
  await deps.store.addOutbox({ channel: 'sms', toPersonId: to.id, from, body, attachmentRef: null, dedupeKey });
}

export async function handleTask(task: TaskRow, deps: WorkerDeps): Promise<Outcome> {
  const runId = randomUUID();
  if (task.kind === 'inbound_text') return inbound(task, deps, runId);
  if (task.kind === 'mailbox') return mailbox(task, deps, runId);
  return fail(`unsupported task kind ${task.kind}`);
}

async function inbound(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const payload = task.payload as { from?: string; body?: string };
  const person = payload.from ? await deps.store.personByPhone(payload.from) : null;
  if (!person || !payload.body) return fail('the sender is not registered or the text is empty');
  const command = parseCommand(payload.body);
  if (command) return handleCommand(command, person, task, deps, runId);

  if (person.assistant_id === 'finance') {
    await text(deps, person, 'finance', 'In this build your assistant takes plan requests from the owner. Reply STATUS for open items.', `reply:${task.id}`);
    return done;
  }
  const started = deps.now();
  let routed;
  try {
    routed = await routeText(deps.models.nvidia, deps.models.routerModel, payload.body, person.assistant_id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'router failed';
    await receipt(deps, { runId, taskId: task.id, step: 'front-door', assistant: person.assistant_id, started, outcome: 'failed', model: deps.models.routerModel, detail });
    await text(deps, person, person.assistant_id, "I couldn't reach the routing model just now, so nothing was started. Please try again in a minute.", `reply:${task.id}`);
    return fail(`front door failed: ${detail}`);
  }
  await receipt(deps, {
    runId, taskId: task.id, step: 'front-door', assistant: person.assistant_id, started, model: routed.model,
    outcome: routed.valid ? 'ok' : 'refused',
    detail: `${routed.decision.intent} → ${routed.decision.targetAssistant}; risks: ${routed.decision.risks.join(',') || 'none'}; ${routed.decision.reason}`,
  });
  if (routed.decision.targetAssistant !== 'finance') {
    await text(deps, person, person.assistant_id, `That sounds like one for the ${routed.decision.targetAssistant} assistant. In this build only the finance assistant runs, so I've saved it.`, `reply:${task.id}`);
    return done;
  }
  const request = await deps.store.postMessage({
    from: person.assistant_id, to: 'finance', kind: 'request', replyTo: null, dedupeKey: `request:${task.id}`,
    body: { text: payload.body, personId: person.id, risks: routed.decision.risks, taskId: task.id },
  });
  await deps.brain.record.request({
    taskId: task.id, personId: person.id, personName: person.name, from: person.assistant_id, to: 'finance',
    text: payload.body, at: started.toISOString(), runId,
  });
  await deps.store.enqueueTask({ assistant: 'finance', kind: 'mailbox', key: `mailbox:${request.id}`, payload: { messageId: request.id }, now: deps.now() });
  return done;
}

async function mailbox(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const messageId = String((task.payload as { messageId?: string }).messageId ?? '');
  const request = await deps.store.message(messageId);
  if (request.kind !== 'request' || request.to_assistant !== 'finance') return fail('mailbox item is not a finance request');
  const requester = await deps.store.personByAssistant(request.from_assistant);
  const askText = String(request.body.text ?? '');

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
    });
  } catch (error) {
    const detail = error instanceof PlanError ? error.objections.join(' | ') : error instanceof Error ? error.message : 'unknown error';
    await receipt(deps, { runId, taskId: task.id, step: 'finance.plans', assistant: 'finance', started, outcome: 'failed', model: deps.models.planModel, detail });
    await text(deps, requester, 'finance', "I couldn't produce plans whose numbers all check out, so I'm not sending any. The reasons are on the console.", `reply:${task.id}`);
    return fail(`plans not produced: ${detail}`);
  }
  await receipt(deps, {
    runId, taskId: task.id, step: 'finance.plans', assistant: 'finance', started, outcome: 'ok', model: result.model,
    dataSource: `zetaris:${result.view}#${result.queryHash.slice(0, 12)}`,
    detail: `attempts ${result.attempts}, tokens ${result.tokens}, cited ${result.citedMetricIds.length} metrics`,
  });

  const cited = result.metrics.filter((m) => result.citedMetricIds.includes(m.id));
  const proposal = await deps.store.postMessage({
    from: 'finance', to: request.from_assistant, kind: 'proposal', replyTo: request.id, dedupeKey: `proposal:${request.id}`,
    body: { plans: result.plans, metrics: cited, queryHash: result.queryHash, view: result.view, model: result.model, declinedEchoes: result.declinedEchoes, requestText: askText },
  });
  const stamp = { at: deps.now().toISOString(), runId };
  await deps.brain.record.proposal({
    proposalId: proposal.id, requestTaskId: String(request.body.taskId ?? request.id), by: 'finance', forPersonId: requester.id,
    titles: result.plans.plans.map((p) => p.title), citedMetricIds: result.citedMetricIds,
    dataSource: `zetaris:${result.queryHash}`, ...stamp,
  });
  deps.brain.memory('finance').rememberProposal({ proposalId: proposal.id, summary: result.plans.plans.map((p) => `${p.rank}. ${p.title}`).join(' / '), runId });

  const financeOwner = await deps.store.personByAssistant('finance');
  const code = newCode();
  await deps.store.createApproval({ messageId: proposal.id, personId: requester.id, action: 'forward_plan', code, now: deps.now() });
  const echoes = result.declinedEchoes.length
    ? `\nNote: plan ${[...new Set(result.declinedEchoes.map((e) => e.rank))].join(', ')} resembles an idea that was declined before.`
    : '';
  await text(deps, requester, 'finance',
    `Your finance assistant's 3 plans (every number checked against ${result.view}):\n${planDigest(result.plans)}${echoes}\nReply SEND <1-3> ${code} to send one to ${financeOwner.name}. The code expires in 15 minutes.`,
    `proposal-sms:${proposal.id}`);
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
      await reply(`Open items for your assistant: ${await deps.store.openTaskCount(person.assistant_id)}.`);
      return done;
    }
    case 'send':
      return forwardPlan(command, person, task, deps, runId, started, reply);
    case 'confirm':
    case 'decline':
      return decidePlan(command, person, task, deps, runId, started, reply);
  }
}

async function forwardPlan(
  command: Extract<Command, { kind: 'send' }>, person: PersonRow, task: TaskRow, deps: WorkerDeps,
  runId: string, started: Date, reply: (b: string) => Promise<void>,
): Promise<Outcome> {
  const used = await deps.store.useApprovalCode({ phone: person.phone, code: command.code, verdict: 'signed', detail: { planRank: command.planRank }, now: started });
  if (used.outcome !== 'signed' || used.action !== 'forward_plan' || !used.message_id) {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.forward', assistant: person.assistant_id, started, outcome: 'refused', detail: 'code refused' });
    await reply("That code didn't work or has expired. Nothing was sent.");
    return done;
  }
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
  await deps.store.createApproval({ messageId: forward.id, personId: financeOwner.id, action: 'decide_plan', code, now: deps.now() });
  await text(deps, financeOwner, 'finance',
    `${person.name} sent you plan ${plan.rank}: ${plan.title}\n${plan.summary}\nTest: ${plan.test}\nStop-loss: ${plan.stopLoss}\nReply CONFIRM ${code} or DECLINE ${code}. The code expires in 15 minutes.`,
    `forward-sms:${forward.id}`);
  await deps.store.addOutbox({ channel: 'print', toPersonId: financeOwner.id, from: 'finance', body: `Plan ${plan.rank} for decision`, attachmentRef: `proposal:${proposal.id}`, dedupeKey: `forward-print:${forward.id}` });
  await deps.brain.record.decision({ proposalId: proposal.id, personId: person.id, personName: person.name, verdict: 'signed', planRank: plan.rank, action: 'forward_plan', at: deps.now().toISOString(), runId });
  await receipt(deps, { runId, taskId: task.id, step: 'approval.forward', assistant: person.assistant_id, started, outcome: 'ok', detail: `plan ${plan.rank} forwarded to ${financeOwner.id}` });
  await reply(`Sent plan ${plan.rank} to ${financeOwner.name}.`);
  return done;
}

async function decidePlan(
  command: Extract<Command, { kind: 'confirm' | 'decline' }>, person: PersonRow, task: TaskRow, deps: WorkerDeps,
  runId: string, started: Date, reply: (b: string) => Promise<void>,
): Promise<Outcome> {
  const verdict = command.kind === 'confirm' ? 'signed' : 'declined';
  const used = await deps.store.useApprovalCode({ phone: person.phone, code: command.code, verdict, detail: {}, now: started });
  if (used.outcome !== verdict || used.action !== 'decide_plan' || !used.message_id) {
    await receipt(deps, { runId, taskId: task.id, step: 'approval.decide', assistant: person.assistant_id, started, outcome: 'refused', detail: 'code refused' });
    await reply("That code didn't work or has expired. Nothing was recorded.");
    return done;
  }
  const forward: MessageRow = await deps.store.message(used.message_id);
  const proposalId = String(forward.body.proposalId ?? '');
  const planRank = Number(forward.body.planRank ?? 0);
  const proposal = await deps.store.message(proposalId);
  const plan = (proposal.body.plans as ProfitPlans).plans.find((p) => p.rank === planRank);
  const owner = await deps.store.person(String(forward.body.forwardedBy ?? ''));
  const word = verdict === 'signed' ? 'approved' : 'declined';
  const stamp = { at: deps.now().toISOString(), runId };

  await deps.brain.record.decision({ proposalId, personId: person.id, personName: person.name, verdict, planRank, action: 'decide_plan', ...stamp });
  deps.brain.memory('finance').rememberDecision({ proposalId, personId: person.id, verdict, planRank, planTitle: plan?.title ?? `plan ${planRank}`, runId });
  await deps.store.postMessage({ from: 'finance', to: owner.assistant_id, kind: 'decision', replyTo: forward.id, dedupeKey: `decision:${forward.id}`, body: { proposalId, planRank, verdict, by: person.id } });
  await text(deps, owner, 'finance', `${person.name} ${word} plan ${planRank}: ${plan?.title ?? ''}`.trim(), `decision-sms:${forward.id}`);
  await receipt(deps, { runId, taskId: task.id, step: 'approval.decide', assistant: 'finance', started, outcome: 'ok', detail: `plan ${planRank} ${word} by ${person.id}` });
  await reply(`Recorded: you ${word} plan ${planRank}. Thank you.`);
  return done;
}

export function citedMetricsOf(proposal: MessageRow): Metric[] {
  return (proposal.body.metrics as Metric[] | undefined) ?? [];
}
