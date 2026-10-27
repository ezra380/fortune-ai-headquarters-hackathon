# @fahq/data

The assistants' numbers, read through Zetaris. Owner: lane A (Claude). Two versions live side by side:
version 1 (the live default) and version 2 (`FAHQ_DATA_VERSION=2`), described in `docs/data.md`.

- `src/synthetic.ts`: seeded, invented business data. `generateBusiness()` is version 1 (Sept 1 to Oct 26, 2026, three planted bad rows, frozen). `generateYear()` is version 2: `generateHistory()` (Oct 2025 to Aug 2026, the invented `SEASON`), version 1's rows unchanged, and `generateDivisions()` (Meta ad days and the finance owner's budget sheet), each from its own seeded stream.
- `src/source-server.ts`: the "source systems" as a read-only local JSON API: version 1's routes, and version 2's under `/v2`. Version 1's tables read port 18120, version 2's port 18121, both at `host.docker.internal`.
- `src/finance-sql.ts`: the metric catalog (with each metric's divisions, layer and notes), defined once and turned into both the governed Zetaris views (`fortune_hq.finance_metrics` for version 1, `fortune_hq_v2.period_metrics` for version 2, with the data-quality rules) and `computeAll()`, the independent TypeScript computation used as the test oracle. It also holds version 1's Virtual Data Mart statements (`fortune_demo_finance_mart.finance_metrics`).
- `src/layers.ts`: version 2's derived view (budget left and used, total ad spend, revenue per ad dollar, the season index) and standing view (as of 2026-10-26), each with its oracle (`computeLayers()`).
- `src/divisions.ts`: the catalog across all three layers, each division's filter views and Virtual Data Mart (`fortune_demo_v2_*_mart`), a division read's queries and hash text, and the fixed attention list.
- `src/zetaris-objects.ts`: version 2's Zetaris objects, which never name a version 1 object.
- `src/zetaris-client.ts`: Zetaris SQL over its REST API (`/sql-editor/sqls/run`).
- `src/index.ts`: `createZetarisDataPort(env)`, the `DataPort` the worker and the Code Mode brain use. Under version 2 it adds `getDivisionMetrics({ division, period, asOf })`, which reads one division's mart.
- `scripts/zetaris-probe.ts`: the live test of the SQL shapes version 2 needs (windows, a view on a view, a two-table mart).

Set up Zetaris once for version 1 (creates three Lightning databases, four REST tables, five views and the Virtual Data Mart, then proves that the view and the mart table each equal the independent computation, 33 metrics of 33, for both periods). A normal run only creates what is missing:

```bash
npm run zetaris:setup
npm run zetaris:setup -- --v2     # version 2's objects only, beside version 1's: views, division marts; proves every layer, mart and division read
```

`-- --recreate` drops and rebuilds (version 1: the mart, the views and tables; do not run it while the worker is reading them. With `--v2`: only version 2's views and tables); `-- --verify-only` only runs the proof. Zetaris settings (`ZETARIS_*`) come from `.env.local` and are never printed.
