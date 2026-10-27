import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';

// A Code Mode Executor (the interface @cloudflare/codemode calls) that runs model-written code in a
// QuickJS WebAssembly sandbox: no network, no files, no timers, no host objects. The only way out
// is a call to a tool the host passed in, and every call is counted. On Cloudflare the same
// interface is served by DynamicWorkerExecutor (Worker Loader); nothing else changes.
//
// Each run gets its own WebAssembly module and memory (about 5 ms to start), with a hard maximum:
// QuickJS's own memory limit did not stop typed arrays or Array.fill (a probe grew the host to
// about 2 GB), and a shared module stayed broken after a stack overflow. A run's memory is dropped
// with its module. The QuickJS stack limit stays below what V8 allows: at 512 KB, deep recursion
// overflowed V8's stack first and aborted the module instead of raising "stack overflow".

const MB = 1024 * 1024;
const WASM_PAGE = 64 * 1024;
const STACK_BYTES = 256 * 1024;
// The constructor exists at runtime in Node; this repo's TypeScript libs declare only the types.
type WasmMemoryT = NonNullable<Parameters<typeof newVariant>[1]['wasmMemory']>;
const WasmMemory = (globalThis as unknown as {
  WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => WasmMemoryT };
}).WebAssembly.Memory;

type ToolFn = (...args: unknown[]) => Promise<unknown>;
export type ResolvedProvider = { name: string; fns: Record<string, ToolFn> };
/** `toolCalls` counts every call the script made to a `codemode.*` function, including refused ones. */
export type ExecuteResult = { result: unknown; error?: string; logs?: string[]; toolCalls: number };

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
    const count = { toolCalls: 0 };
    const outcome = await this.run(code, providersOrFns, count);
    return { ...outcome, toolCalls: count.toolCalls };
  }

  private async run(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, ToolFn>,
    count: { toolCalls: number },
  ): Promise<Omit<ExecuteResult, 'toolCalls'>> {
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

    const memoryBytes = this.opts.memoryBytes ?? 32 * MB;
    // The module's heap: the script's limit plus room for QuickJS itself, never above 256 MB.
    const maxPages = Math.min(4096, Math.ceil((memoryBytes + 32 * MB) / WASM_PAGE));
    const QuickJS = await newQuickJSWASMModuleFromVariant(
      newVariant(RELEASE_SYNC, { wasmMemory: new WasmMemory({ initial: 256, maximum: Math.max(256, maxPages) }) }),
    );
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(STACK_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const vm = runtime.newContext();

    const logs: string[] = [];
    const pending = new Set<QuickJSDeferredPromise>();
    let disposed = false;
    // A failure while running the script's continuation after a tool call (outside execute's own
    // try): it ends the run instead of escaping as an unhandled rejection that kills the process.
    let fatal: string | null = null;
    let onFatal: () => void = () => {};
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
          count.toolCalls += 1;
          if (count.toolCalls > maxToolCalls) throw new Error(`tool call limit (${maxToolCalls}) reached`);
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
          if (disposed || fatal) return;
          try {
            const jobs = runtime.executePendingJobs();
            if (jobs.error) {
              fatal = describe(vm, jobs.error);
              jobs.error.dispose();
              onFatal();
            }
          } catch (error) {
            fatal = error instanceof Error ? error.message : String(error);
            onFatal();
          }
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
      const failed = new Promise<'fatal'>((resolve) => {
        onFatal = () => resolve('fatal');
      });
      const first = runtime.executePendingJobs();
      if (first.error) {
        fatal = describe(vm, first.error);
        first.error.dispose();
      }
      if (fatal) return { result: undefined, error: failure(fatal, timeoutMs), logs };

      const outcome = await raceDeadline(Promise.race([settled, failed]), deadline);
      if (outcome === 'timeout') return { result: undefined, error: `timed out after ${timeoutMs} ms`, logs };
      if (outcome === 'fatal') return { result: undefined, error: failure(fatal ?? '', timeoutMs), logs };
      if (outcome.error) {
        const message = describe(vm, outcome.error);
        outcome.error.dispose();
        return { result: undefined, error: failure(message, timeoutMs), logs };
      }
      const value = vm.dump(outcome.value) as unknown;
      outcome.value.dispose();
      return { result: value, logs };
    } catch (error) {
      return { result: undefined, error: failure(error instanceof Error ? error.message : String(error), timeoutMs), logs };
    } finally {
      disposed = true;
      // A runtime broken by a host-side overflow can abort on dispose; the module is thrown away anyway.
      try {
        for (const d of pending) d.dispose();
        vm.dispose();
        runtime.dispose();
      } catch {
        // nothing to release that the dropped module does not take with it
      }
    }
  }
}

/** A run's error text: never empty (an empty error reads as success to Code Mode). */
function failure(message: string, timeoutMs: number): string {
  if (/interrupted/i.test(message)) return `timed out after ${timeoutMs} ms`;
  if (/Maximum call stack size exceeded/i.test(message)) return 'stack overflow';
  const text = message.trim().slice(0, 500);
  return text === '' ? 'the script failed without a message' : text;
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
