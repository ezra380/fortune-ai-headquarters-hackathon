// Small pieces every metric definition is built from, in SQL and in TypeScript side by side: the SQL goes into
// the Zetaris views, the TypeScript is the oracle that proves them. The TypeScript side follows SQL's NULL
// rules (a comparison with NULL is not true), so both sides count the same rows.

export type Row = Record<string, unknown>;
/** A column, or an expression over a row with its TypeScript twin. */
export type Field = string | { sql: string; js: (r: Row) => number };
/** A condition on a row beyond equality, with its TypeScript twin. */
export type Cond = { sql: string; js: (r: Row) => boolean };
/** A source's row view (in each version's container), the column that dates a row, and its data-quality rule. */
export type SourceSpec = { table: string; date: string; validSql: string; valid: (r: Row) => boolean };

export const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
export const num = (r: Row, k: string) => Number(r[k]);
/** SQL's IN over a list of strings: never true for NULL. */
export const oneOf = (xs: readonly string[], v: unknown) => (xs as readonly unknown[]).includes(v);
export const isNull = (v: unknown) => v === null || v === undefined;

/** Both conditions (SQL AND). */
export const both = (a: Cond, b: Cond): Cond => ({ sql: `${a.sql} AND ${b.sql}`, js: (r) => a.js(r) && b.js(r) });
/** 1 for a row that meets the condition, else 0: summed over the rows and divided by their count, a share. */
export const oneIf = (c: Cond): Field => ({ sql: `CASE WHEN ${c.sql} THEN 1 ELSE 0 END`, js: (r) => (c.js(r) ? 1 : 0) });
/** 1 for every row: the denominator of a share. */
export const ONE: Field = { sql: '1', js: () => 1 };
