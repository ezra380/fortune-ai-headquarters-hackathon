# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.
Code Mode's reply step works as the worker's does: when a number in the reply is not in the script's result, the model gets one correction round (its tokens are counted).

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | no | 2 | 4,625 | 526 | 5,151 | 1 | 9.1 | no answer | n/a |
| Q1 | Tool loop | yes | 6 | 29,390 | 248 | 29,638 | 4 | 16.0 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,765 | 250 | 3,015 | 1 | 11.0 | yes | 3 of 3 |
| Q2 | Tool loop | yes | 6 | 28,144 | 197 | 28,341 | 4 | 16.0 | yes | 3 of 3 |
| Q3 | Code Mode | no | 2 | 4,748 | 791 | 5,539 | 0 | 13.2 | no answer | n/a |
| Q3 | Tool loop | yes | 6 | 13,198 | 87 | 13,285 | 5 | 2.2 | yes | n/a |
| **All** | **Code Mode** | 1 of 3 | 6 | 12,138 | 1,567 | 13,705 | 2 | 33.3 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 70,732 | 532 | 71,264 | 13 | 34.2 | | |

## Code Mode against the tool loop

- Total tokens: 80.8% fewer
- Input tokens: 82.8% fewer
- Output tokens: 194.5% more
- Model calls: 66.7% fewer
- Wall time: 2.7% fewer

A run that gave no answer still counts its tokens, so the comparison above is not like for like.

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode** (no answer: the script did not give a usable answer: unexpected token in expression: '\')

Script the model wrote:

```js
async () => {\n  const finance = await codemode.get_finance_metrics({ period: \"2026-09\" });\n  const g = finance.metrics[\"m:online.ads.google\"];\n  const a = finance.metrics[\"m:online.ads.amazon\"];\n  const e = finance.metrics[\"m:online.email.revenue\"];\n  return {\n    googleSpend: g?.value ?? null,\n    googleRevenue: g?.business === \"online\" ? finance.metrics[\"m:online.ads.google.revenue\"]?.value ?? null : null,\n    googleROAS: g?.business === \"online\" ? finance.metrics[\"m:online.ads.google.roas\"]?.value ?? null : null,\n    amazonSpend: a?.value ?? null,\n    amazonRevenue: a?.business === \"online\" ? finance.metrics[\"m:online.ads.amazon.revenue\"]?.value ?? null : null,\n    amazonROAS: a?.business === \"online\" ? finance.metrics[\"m:online.ads.amazon.roas\"]?.value ?? null : null,\n    emailRevenue: e?.value ?? null\n  };\n}
```

**Tool loop**

> Google ads: spend $2,199.09, revenue $6,806.18, ROAS 3.095. Amazon ads: spend $477.57, revenue $1,089.98, ROAS 2.282. Email revenue: $20,243.41. All figures for September 2026.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The salon service that brought in the most revenue in September was cut and style with $11,347.46. There were 5 no-shows.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const salonMetrics = finance.metrics;
  let topService = null;
  let topValue = -1;
  const serviceIds = [
    "m:salon.revenue.wash_set",
    "m:salon.revenue.cut_style",
    "m:salon.revenue.repair",
    "m:salon.revenue.consignment_intake",
    "m:salon.revenue.color",
    "m:salon.revenue.fortune_appointment"
  ];
  for (const id of serviceIds) {
    const m = salonMetrics[id];
    if (m && m.value > topValue) {
      topValue = m.value;
      topService = m.label;
    }
  }
  const noShows = salonMetrics["m:salon.no_shows.count"]?.value ?? 0;
  return { topService, topValue, noShows };
}
```

**Tool loop**

> The salon service with the most revenue in September was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode** (no answer: the script did not give a usable answer: unexpected token in expression: '\')

Script the model wrote:

```js
async () => {\n  const latest = await codemode.latest_proposal({});\n  const explain = await codemode.explain_proposal({ proposal: latest?.proposal?.id });\n\n  const declinedAds = await codemode.recall_decisions({\n    assistant: \"owner\",\n    query: \"ads plan declined\",\n    limit: 20\n  });\n\n  return {\n    latestProposalId: latest?.proposal?.id,\n    createdAt: latest?.proposal?.createdAt,\n    titles: latest?.proposal?.titles,\n    citedMetricIds: latest?.proposal?.citedMetricIds,\n    proposalExists: !!latest?.proposal,\n    explain: explain ? {\n      requestText: explain.proposal?.requestText,\n      pickedBy: explain.proposal?.pickedBy,\n      failedDepartments: explain.proposal?.failedDepartments,\n      cited: explain.cited?.map(c => ({ id: c.id, label: c.label, value: c.value, unit: c.unit, business: c.business })) : [],\n      approvals: explain.approvals?.map(a => ({ action: a.action, status: a.status, planRank: a.planRank, decidedAt: a.decidedAt })) : [],\n      decisions: explain.decisions?.map(d => ({ by: d.by, action: d.action, planRank: d.planRank, at: d.at })) : []\n    } : null,\n    declinedAdsPlan: declinedAds.decisions?.some(d => d.action?.toLowerCase().includes(\"ads\") && d.action.toLowerCase().includes(\"decline\")),\n    declinedAdsDetails: declinedAds.decisions?.filter(d => d.action?.toLowerCase().includes(\"ads\"))\n  };\n}
```

**Tool loop**

> No latest proposal found. No prior ad plan declines recorded.

