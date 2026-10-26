import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';

// A Code Mode Executor (the interface @cloudflare/codemode calls) that runs model-written code in a
// QuickJS WebAssembly sandbox: no network, no files, no timers, no host objects. The only way out
// is a call to a tool the host passed in, and every call is counted. On Cloudflare the same
// interface is served by DynamicWorkerExecutor (Worker Loader); nothing else changes.

type ToolFn = (...args: unknown[]) => Promise<unknown>;
export type ResolvedProvider = { name: string; fns: Record<string, ToolFn> };
export type ExecuteResult = { result: unknown; error?: string; logs?: string[] };

export type QuickJsExecutorOptions = {
  timeoutMs?: number;
  memoryBytes?: number;
  maxToolCalls?: number;
  maxLogLines?: number;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class QuickJsExecutor {
  constructor(private readonly opts: QuickJsExecutorOptions = {}) {}

  async execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, ToolFn>,
  ): Promise<ExecuteResult> {
    const providers: ResolvedProvider[] = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: 'codemode', fns: providersOrFns }];
    for (const p of providers) {
      if (!IDENTIFIER.test(p.name)) return { result: undefined, error: `invalid provider name ${p.name}` };
    }
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const maxToolCalls = this.opts.maxToolCalls ?? 50;
    const maxLogLines = this.opts.maxLogLines ?? 100;
    const deadline = Date.now() + timeoutMs;

    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.opts.memoryBytes ?? 32 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const vm = runtime.newContext();

    const logs: string[] = [];
    const pending = new Set<QuickJSDeferredPromise>();
    let disposed = false;
    let toolCalls = 0;
    const byName = new Map(providers.map((p) => [p.name, p.fns]));

    try {
      installConsole(vm, logs, maxLogLines);

      const bridge = vm.newFunction('__fahq_call', (providerH, nameH, argsH) => {
        const provider = vm.getString(providerH);
        const name = vm.getString(nameH);
        const argsJson = vm.getString(argsH);
        const deferred = vm.newPromise();
        pending.add(deferred);
        const fns = byName.get(provider);
        const run = async (): Promise<string> => {
          toolCalls += 1;
          if (toolCalls > maxToolCalls) throw new Error(`tool call limit (${maxToolCalls}) reached`);
          if (!fns || !Object.hasOwn(fns, name)) throw new Error(`unknown tool ${provider}.${name}`);
          const args = JSON.parse(argsJson) as unknown[];
          return JSON.stringify((await fns[name]!(...args)) ?? null);
        };
        run().then(
          (json) => {
            if (disposed) return;
            const h = vm.newString(json);
            deferred.resolve(h);
            h.dispose();
          },
          (error: unknown) => {
            if (disposed) return;
            const h = vm.newError(String(error instanceof Error ? error.message : error).slice(0, 500));
            deferred.reject(h);
            h.dispose();
          },
        );
        void deferred.settled.then(() => {
          pending.delete(deferred);
          if (!disposed) runtime.executePendingJobs();
        });
        return deferred.handle;
      });
      vm.setProp(vm.global, '__fahq_call', bridge);
      bridge.dispose();

      const setup = providers
        .map((p) => {
          const n = JSON.stringify(p.name);
          return `globalThis[${n}] = new Proxy({}, { get: (_, m) => (typeof m !== 'string' || m === 'then') ? undefined : (...a) => __fahq_call(${n}, m, JSON.stringify(a)).then(JSON.parse) });`;
        })
        .join('\n');
      vm.unwrapResult(vm.evalCode(setup)).dispose();

      const started = vm.evalCode(`(${code})()`);
      if (started.error) {
        const message = describe(vm, started.error);
        started.error.dispose();
        return { result: undefined, error: message, logs };
      }
      const settled = vm.resolvePromise(started.value);
      started.value.dispose();
      runtime.executePendingJobs();

      const outcome = await raceDeadline(settled, deadline);
      if (outcome === 'timeout') return { result: undefined, error: `timed out after ${timeoutMs} ms`, logs };
      if (outcome.error) {
        const message = describe(vm, outcome.error);
        outcome.error.dispose();
        return { result: undefined, error: message, logs };
      }
      const value = vm.dump(outcome.value) as unknown;
      outcome.value.dispose();
      return { result: value, logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { result: undefined, error: /interrupted/i.test(message) ? `timed out after ${timeoutMs} ms` : message.slice(0, 500), logs };
    } finally {
      disposed = true;
      for (const d of pending) d.dispose();
      vm.dispose();
      runtime.dispose();
    }
  }
}

function installConsole(vm: QuickJSContext, logs: string[], max: number): void {
  const log = vm.newFunction('log', (...args: QuickJSHandle[]) => {
    if (logs.length >= max) return;
    logs.push(args.map((a) => safeString(vm.dump(a))).join(' ').slice(0, 1000));
  });
  const consoleObj = vm.newObject();
  for (const level of ['log', 'info', 'warn', 'error']) vm.setProp(consoleObj, level, log);
  vm.setProp(vm.global, 'console', consoleObj);
  consoleObj.dispose();
  log.dispose();
}

function describe(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object' && 'message' in dumped) {
    return String((dumped as { message: unknown }).message).slice(0, 500);
  }
  return safeString(dumped).slice(0, 500);
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
