# @fahq/data

The finance assistant's numbers, read through Zetaris. Owner: lane A (Claude).

- `src/synthetic.ts`: seeded, invented business data (Sept 1 to Oct 26, 2026) with three planted bad rows.
- `src/source-server.ts`: the three "source systems" (salon bookings, online orders, marketing) as a read-only local JSON API on port 18120. Zetaris reads it at `host.docker.internal:18120`.
- `src/finance-sql.ts`: the metric catalog, defined once and turned into both the governed Zetaris view `fortune_hq.finance_metrics` (with the data-quality rules) and an independent TypeScript computation used as the test oracle.
- `src/zetaris-client.ts`: Zetaris SQL over its REST API (`/sql-editor/sqls/run`).
- `src/index.ts`: `createZetarisDataPort(env)`, the `DataPort` the worker and the Code Mode brain use.

Set up Zetaris once (creates three Lightning databases, four REST tables, five views, then proves the view equals the independent computation for both periods):

```bash
npm run zetaris:setup
```

`-- --recreate` drops and rebuilds the tables and views; `-- --verify-only` only runs the proof. Zetaris settings (`ZETARIS_*`) come from `.env.local` and are never printed.
