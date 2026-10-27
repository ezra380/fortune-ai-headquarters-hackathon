// A recording fake of the Supabase client: every query is noted (table, selected columns, filters) and answered by the test.
// No network and no database. Shared by the console tests.

export type Call = { table: string; select: string; options: unknown; ops: string[] };

export function recorder(answer: (call: Call) => { data: unknown; error?: { message: string; code?: string } | null; count?: number | null }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, select: '', options: undefined, ops: [] };
      calls.push(call);
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                const a = answer(call);
                return Promise.resolve({ data: a.data, error: a.error ?? null, count: a.count ?? null }).then(resolve, reject);
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'select') {
                call.select = String(args[0]);
                call.options = args[1];
              } else call.ops.push(`${prop}(${args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(',')})`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as never, calls };
}
