# The division data (version 2, built beside version 1)

Every number here is synthetic. Version 1 is what the live worker reads today: the view
`fortune_hq.finance_metrics` over four REST sources, 33 metrics, two periods. Version 2 grows the data
beside it for the four divisions (Salon, Finance, Online, HQ) and is switched on with
`FAHQ_DATA_VERSION=2`; the default stays 1 until the merge, so the live worker never changes underneath.
The design of record is the lane's division design (`A-divisions.md`, written from bb29578).

## Slice 0: what the local Zetaris accepts (live test, 2026-10-27)

Script: `packages/data/scripts/zetaris-probe.ts` (`npx tsx packages/data/scripts/zetaris-probe.ts`). It
serves its own tiny invented source on a free port, creates only `fortune_demo_probe*` objects, checks
every answer against values computed from the same rows, and drops what it made. It never touches the
live source server (port 18120) or any version 1 object. Result of the run at 07:55 ET: every check
passed.

| Shape | Works | Notes |
|---|---|---|
| `AVG(...) OVER ()` on a REST view grouped by period | yes | 0.35 s warm |
| `LAG(idx, 12) OVER (ORDER BY period)` on top of that | yes | period keys sort correctly as strings |
| Window columns, then `stack()` unpivot, then `WHERE value IS NOT NULL` | yes | the exact shape of `sourceSelect()` |
| A view: windowed source `UNION ALL` a second source | yes | |
| That view asked for one period (`WHERE period = …`) | yes, values right | the filter is not pushed below the window, so the season index still averages all twelve months |
| A view that reads another view (`MAX(CASE …) GROUP BY period`, then `stack`) | yes | about 3 s: it re-runs the whole period view underneath |
| Two different REST views joined in one statement | yes | |
| `DATEDIFF`, `unix_timestamp` differences in minutes, `COUNT(DISTINCT …)` | yes | for the later repair and message metrics |
| A Virtual Data Mart with two tables (period view, and the view that reads it) | yes | `SHOW DATAMART TABLES` lists both; each answers alone and per period |
| `DROP DATAMART`, `DROP VIEW`, `DROP LIGHTNING DATABASE TABLE`, `DROP LIGHTNING DATABASE` | yes | |
| Dropping a schemastore container | **no SQL for it** | `DROP SCHEMASTORE CONTAINER` and `DROP CONTAINER` are parse errors; the empty container `fortune_demo_probe` stays |

Two things learned the hard way:

- **A Lightning database and a schemastore container share one namespace, case-insensitively.** After the
  first run left the container `fortune_demo_probe`, `CREATE LIGHTNING DATABASE FORTUNE_DEMO_PROBE`
  failed with "A container named FORTUNE_DEMO_PROBE already exists". Never give a database and a
  container the same name (version 1's `FORTUNE_DEMO_*` databases and the `fortune_hq` container are fine).
- Because window functions work, the season index stays in Zetaris (computed from the grouped rows in the
  period view), not in TypeScript. The oracle computes the same number independently.
