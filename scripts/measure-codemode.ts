// LIVE: measures what Code Mode saves against classic tool calling, on real NVIDIA models and the real
// read tools. It needs the network, NEMOTRON_API_KEY, the Supabase and Zetaris settings in .env.local
// and apps/worker/src/read-tools.ts (createReadTools). It never sends a text and writes nothing but its
// report (docs/research/codemode-savings-<date>.md). Usage:
//   npx tsx scripts/measure-codemode.ts
//
// Both arms get the same model, the same skill (the owner's) and the same read tools (the owner's):
//   A  Code Mode: the model writes one script, the sandbox runs it, a second call writes the reply
//      from the script's small result (createCodeModeRunner + writeAnswer).
//   B  Tool loop: the model asks for one tool at a time and the whole transcript is re-sent each round.
// Tokens are the provider's own counts. Whether a reply's numbers are real is checked against an oracle:
// the same read tools called directly by this script, with no model in between.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelPort, ReadTool } from '@fahq/contracts';
import { createCodeModeRunner, mentions, toolLoopAnswer, traceNumbers, writeAnswer } from '@fahq/codemode';
import { loadProfiles, pickTools } from '@fahq/profiles';

const PERIOD = '2026-09';
const PURPOSE = 'measure.owner.lookup';

export type Arm = 'Code Mode' | 'Tool loop';

/** What the oracle knows about one question. `facts` is null when the oracle could not be read. */
export type Question = {
  text: string;
  facts: unknown;
  /** Values a good reply states; each says whether a reply does. */
  keys: { name: string; found: (reply: string) => boolean }[];
  oracleError: string | null;
};

export type Row = {
  question: string;
  arm: Arm;
  ok: boolean;
  error: string | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  seconds: number;
  answer: string | null;
  /** Code Mode only: the script the model wrote. */
  script: string | null;
  /** Numbers in the reply that are not in the oracle facts; null when not checked. */
  objections: string[] | null;
  keysFound: { found: number; of: number } | null;
};

// ---- Measuring ---------------------------------------------------------------------------------

function countModel(model: ModelPort) {
  const tally = { calls: 0, input: 0, output: 0 };
  const counted: ModelPort = {
    async chat(input) {
      tally.calls += 1;
      const r = await model.chat(input);
      tally.input += r.inputTokens;
      tally.output += r.outputTokens;
      return r;
    },
  };
  return { counted, tally };
}

function countTools(tools: readonly ReadTool[]) {
  const tally = { calls: 0 };
  const counted = tools.map((t): ReadTool => ({ ...t, run: async (args) => { tally.calls += 1; return t.run(args); } }));
  return { counted, tally };
}

type MeasureInput = {
  model: ModelPort;
  modelId: string;
  skill: string;
  tools: readonly ReadTool[];
  questions: readonly Question[];
  /** Seconds, from any steady clock; injected so tests do not depend on time. */
  clock: () => number;
};

function judge(q: Question, answer: string | null): Pick<Row, 'objections' | 'keysFound'> {
  if (answer === null || q.oracleError !== null) return { objections: null, keysFound: null };
  return {
    objections: traceNumbers(answer, q.facts),
    keysFound: q.keys.length > 0 ? { found: q.keys.filter((k) => k.found(answer)).length, of: q.keys.length } : null,
  };
}

async function runArm(input: MeasureInput, q: Question, arm: Arm): Promise<Row> {
  const { counted: model, tally: usage } = countModel(input.model);
  const { counted: tools, tally: reads } = countTools(input.tools);
  const started = input.clock();
  let answer: string | null = null;
  let error: string | null = null;
  let script: string | null = null;
  try {
    if (arm === 'Code Mode') {
      const run = await createCodeModeRunner({ model })({ purpose: PURPOSE, model: input.modelId, skill: input.skill, question: q.text, tools });
      script = run.script;
      if (run.ok) answer = (await writeAnswer({ model, modelId: input.modelId, skill: input.skill, question: q.text, facts: run.result })).text;
      else error = run.error;
    } else {
      const run = await toolLoopAnswer({ model, modelId: input.modelId, skill: input.skill, question: q.text, tools });
      answer = run.answer;
      error = run.error;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown error';
  }
  return {
    question: q.text, arm, ok: answer !== null, error, modelCalls: usage.calls, inputTokens: usage.input, outputTokens: usage.output,
    toolCalls: reads.calls, seconds: input.clock() - started, answer, script, ...judge(q, answer),
  };
}

/** Each question twice, one arm after the other, so network conditions are as alike as they can be. */
export async function measure(input: MeasureInput): Promise<Row[]> {
  const rows: Row[] = [];
  for (const q of input.questions) {
    rows.push(await runArm(input, q, 'Code Mode'));
    rows.push(await runArm(input, q, 'Tool loop'));
  }
  return rows;
}

// ---- The oracle --------------------------------------------------------------------------------

type MetricRow = { id: string; label: string; value: number };
type Oracle = Pick<Question, 'facts' | 'keys'>;

async function metricsOf(tools: ReadonlyMap<string, ReadTool>): Promise<MetricRow[]> {
  const r = (await tools.get('get_finance_metrics')!.run({ period: PERIOD })) as { metrics?: MetricRow[] };
  if (!Array.isArray(r.metrics) || r.metrics.length === 0) throw new Error('get_finance_metrics returned no metrics');
  return r.metrics;
}

const QUESTIONS: { text: string; oracle: (tools: ReadonlyMap<string, ReadTool>) => Promise<Oracle> }[] = [
  {
    text: 'How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.',
    oracle: async (tools) => {
      const wanted = (await metricsOf(tools)).filter((m) => /^m:online\.(ads\.(google|amazon)\.(spend|revenue|roas)|email\.revenue)$/.test(m.id));
      if (wanted.length === 0) throw new Error('no Google, Amazon or email metrics were found');
      return { facts: wanted, keys: wanted.map((m) => ({ name: m.id, found: (reply) => mentions(reply, m.value) })) };
    },
  },
  {
    text: 'Which salon service brought in the most revenue in September, and how many no-shows were there?',
    oracle: async (tools) => {
      const metrics = await metricsOf(tools);
      const services = metrics.filter((m) => m.id.startsWith('m:salon.revenue.') && m.id !== 'm:salon.revenue.total');
      const noShows = metrics.find((m) => m.id === 'm:salon.no_shows.count');
      const top = services.toSorted((a, b) => b.value - a.value)[0];
      if (!top || !noShows) throw new Error('no salon service revenue or no-show metric was found');
      const name = top.label.replace(/^Salon\s+/i, '').replace(/\s+revenue$/i, '').toLowerCase();
      return {
        facts: [...services, noShows],
        keys: [
          { name: `top service: ${top.id}`, found: (reply) => reply.toLowerCase().includes(name) },
          { name: `its revenue: ${top.value}`, found: (reply) => mentions(reply, top.value) },
          { name: `no-shows: ${noShows.value}`, found: (reply) => mentions(reply, noShows.value) },
        ],
      };
    },
  },
  {
    text: 'What did the latest finance proposal cite, and has anyone declined an ads plan before?',
    oracle: async (tools) => {
      const latestProposal = await tools.get('latest_proposal')!.run({});
      const decisions = await tools.get('recall_decisions')!.run({ assistant: 'finance', query: 'ads plan' });
      return { facts: { latestProposal, decisions }, keys: [] };
    },
  },
];

/** The three questions, each with the facts the read tools give when called directly. */
export async function buildQuestions(tools: readonly ReadTool[]): Promise<Question[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Promise.all(QUESTIONS.map(async ({ text, oracle }): Promise<Question> => {
    try {
      return { text, ...(await oracle(byName)), oracleError: null };
    } catch (error) {
      return { text, facts: null, keys: [], oracleError: error instanceof Error ? error.message : 'unknown error' };
    }
  }));
}

// ---- The report --------------------------------------------------------------------------------

const sum = (rows: readonly Row[], pick: (r: Row) => number) => rows.reduce((total, r) => total + pick(r), 0);
const total = (r: Row) => r.inputTokens + r.outputTokens;
const num = (n: number) => n.toLocaleString('en-US');

/** "N% fewer" or "N% more" for code against loop. */
function versus(code: number, loop: number): string {
  if (loop === 0) return 'n/a';
  const change = ((loop - code) / loop) * 100;
  return `${Math.abs(change).toFixed(1)}% ${change >= 0 ? 'fewer' : 'more'}`;
}

function traceCell(r: Row): string {
  if (!r.ok) return 'no answer';
  if (r.objections === null) return 'not checked (oracle unavailable)';
  return r.objections.length === 0 ? 'yes' : `no (${r.objections.length})`;
}

export function renderReport(input: { date: string; modelId: string; skillName: string; toolNames: readonly string[]; rows: readonly Row[]; questions: readonly Question[] }): string {
  const { rows } = input;
  const code = rows.filter((r) => r.arm === 'Code Mode');
  const loop = rows.filter((r) => r.arm === 'Tool loop');
  const lines: string[] = [
    `# Code Mode against tool calling: measured ${input.date} (LIVE)`,
    '',
    `**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.`,
    `Both arms used model \`${input.modelId}\`, the skill \`${input.skillName}\` and the same ${input.toolNames.length} read tools (${input.toolNames.map((n) => `\`${n}\``).join(', ')}).`,
    'Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.',
    '',
    '| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  rows.forEach((r, i) => {
    const keys = r.keysFound ? `${r.keysFound.found} of ${r.keysFound.of}` : 'n/a';
    lines.push(`| Q${Math.floor(i / 2) + 1} | ${r.arm} | ${r.ok ? 'yes' : 'no'} | ${r.modelCalls} | ${num(r.inputTokens)} | ${num(r.outputTokens)} | ${num(total(r))} | ${r.toolCalls} | ${r.seconds.toFixed(1)} | ${traceCell(r)} | ${keys} |`);
  });
  for (const [arm, set] of [['Code Mode', code], ['Tool loop', loop]] as const) {
    lines.push(`| **All** | **${arm}** | ${set.filter((r) => r.ok).length} of ${set.length} | ${sum(set, (r) => r.modelCalls)} | ${num(sum(set, (r) => r.inputTokens))} | ${num(sum(set, (r) => r.outputTokens))} | ${num(sum(set, total))} | ${sum(set, (r) => r.toolCalls)} | ${sum(set, (r) => r.seconds).toFixed(1)} | | |`);
  }
  lines.push(
    '',
    '## Code Mode against the tool loop',
    '',
    `- Total tokens: ${versus(sum(code, total), sum(loop, total))}`,
    `- Input tokens: ${versus(sum(code, (r) => r.inputTokens), sum(loop, (r) => r.inputTokens))}`,
    `- Output tokens: ${versus(sum(code, (r) => r.outputTokens), sum(loop, (r) => r.outputTokens))}`,
    `- Model calls: ${versus(sum(code, (r) => r.modelCalls), sum(loop, (r) => r.modelCalls))}`,
    `- Wall time: ${versus(sum(code, (r) => r.seconds), sum(loop, (r) => r.seconds))}`,
  );
  const unanswered = rows.filter((r) => !r.ok);
  if (unanswered.length > 0) lines.push('', 'A run that gave no answer still counts its tokens, so the comparison above is not like for like.');
  lines.push('', '## Per question', '');
  input.questions.forEach((q, i) => {
    lines.push(`### Q${i + 1}. ${q.text}`, '');
    if (q.oracleError) lines.push(`The oracle could not be read, so numbers were not checked: ${q.oracleError}`, '');
    for (const r of rows.slice(i * 2, i * 2 + 2)) {
      lines.push(`**${r.arm}**${r.ok ? '' : ` (no answer: ${r.error ?? 'unknown'})`}`, '');
      if (r.answer) lines.push(`> ${r.answer.replace(/\n+/g, '\n> ')}`, '');
      if (r.objections && r.objections.length > 0) lines.push(`Numbers not in the data: ${r.objections.join('; ')}`, '');
      if (r.script) lines.push('Script the model wrote:', '', '```js', r.script, '```', '');
    }
  });
  return `${lines.join('\n')}\n`;
}

// ---- Running it live ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fail = (message: string): never => {
    console.error(`measure-codemode: ${message}`);
    process.exit(1);
  };
  const readToolsPath = '../apps/worker/src/read-tools.ts';
  let createReadTools: unknown;
  try {
    createReadTools = ((await import(readToolsPath)) as { createReadTools?: unknown }).createReadTools;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String(error).includes('read-tools');
    fail(missing ? 'apps/worker/src/read-tools.ts is not there yet (it exports createReadTools). Merge it, then run this again. Nothing was called.' : `read-tools.ts could not be loaded (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'})`);
  }
  if (typeof createReadTools !== 'function') fail('apps/worker/src/read-tools.ts does not export createReadTools yet. Nothing was called.');

  const root = path.resolve(import.meta.dirname, '..');
  const envFile = path.join(root, '.env.local');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  for (const name of ['NEMOTRON_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[name]) fail(`${name} is not set in .env.local`);

  const { modelsFromEnv } = await import('@fahq/models');
  const { openBrain } = await import('@fahq/brain');
  const { createStore } = await import('../apps/worker/src/store.ts');
  const { createZetarisDataPort } = await import('@fahq/data');
  // The brain is read from a private copy: even a recall appends to H-MEM's ledger, and the live worker
  // is the brain's only writer. The copy is deleted when the run ends.
  const liveBrain = path.join(root, '.local/brain');
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-measure-brain-'));
  if (fs.existsSync(liveBrain)) fs.cpSync(liveBrain, snapshot, { recursive: true });
  process.on('exit', () => fs.rmSync(snapshot, { recursive: true, force: true }));
  const ctx = {
    store: createStore(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!),
    brain: await openBrain({ meterlessDir: path.resolve(root, env.METERLESS_DIR ?? '.local/meterless'), dataDir: snapshot, actor: 'measure-codemode' }),
    data: createZetarisDataPort(env),
    now: () => new Date(),
  };
  const built = (createReadTools as (c: typeof ctx, caller: 'owner') => Record<string, ReadTool>)(ctx, 'owner');
  const all = Array.isArray(built) ? Object.fromEntries(built.map((t) => [t.name, t])) : built;

  const owner = loadProfiles(env).owner;
  const tools = pickTools(all, owner);
  const modelId = owner.models.code?.model ?? fail('the owner profile has no code model');
  const questions = await buildQuestions(tools);
  console.error(`LIVE: ${questions.length} questions, model ${modelId}, ${tools.length} read tools`);
  const rows = await measure({ model: modelsFromEnv(env).nvidia, modelId, skill: owner.skill, tools, questions, clock: () => performance.now() / 1000 });

  const date = new Date().toISOString().slice(0, 10);
  const report = renderReport({ date, modelId, skillName: 'fortune-hq-owner', toolNames: tools.map((t) => t.name), rows, questions });
  const dir = path.join(root, 'docs/research');
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `codemode-savings-${date}.md`);
  if (fs.existsSync(file)) file = path.join(dir, `codemode-savings-${date}-${new Date().toISOString().slice(11, 16).replace(':', '')}.md`);
  fs.writeFileSync(file, report, { flag: 'wx' });
  console.log(report);
  console.error(`measure-codemode: report written to ${path.relative(root, file)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
