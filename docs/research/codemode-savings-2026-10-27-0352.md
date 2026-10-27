# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 2,817 | 342 | 3,159 | 1 | 6.4 | yes | 7 of 7 |
| Q1 | Tool loop | yes | 6 | 28,030 | 225 | 28,255 | 4 | 13.8 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,761 | 195 | 2,956 | 2 | 5.7 | no (1) | 1 of 3 |
| Q2 | Tool loop | yes | 6 | 28,018 | 193 | 28,211 | 4 | 13.6 | yes | 3 of 3 |
| Q3 | Code Mode | yes | 2 | 2,744 | 280 | 3,024 | 3 | 6.4 | no (6) | n/a |
| Q3 | Tool loop | yes | 6 | 13,156 | 87 | 13,243 | 5 | 1.8 | yes | n/a |
| **All** | **Code Mode** | 3 of 3 | 6 | 8,322 | 817 | 9,139 | 6 | 18.6 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 69,204 | 505 | 69,709 | 13 | 29.2 | | |

## Code Mode against the tool loop

- Total tokens: 86.9% fewer
- Input tokens: 88.0% fewer
- Output tokens: 61.8% more
- Model calls: 66.7% fewer
- Wall time: 36.4% fewer

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> Google: $2,199.09 spend, $6,806.18 revenue, ROAS 3.095. Amazon: $477.57 spend, $1,089.98 revenue, ROAS 2.2823. Email revenue: $20,243.41.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const gSpend = finance.metrics["m:online.ads.google.spend"]?.value ?? 0;
  const gRevenue = finance.metrics["m:online.ads.google.revenue"]?.value ?? 0;
  const gROAS = finance.metrics["m:online.ads.google.roas"]?.value ?? 0;
  const aSpend = finance.metrics["m:online.ads.amazon.spend"]?.value ?? 0;
  const aRevenue = finance.metrics["m:online.ads.amazon.revenue"]?.value ?? 0;
  const aROAS = finance.metrics["m:online.ads.amazon.roas"]?.value ?? 0;
  const eRevenue = finance.metrics["m:online.email.revenue"]?.value ?? 0;
  return {
    google: { spend: gSpend, revenue: gRevenue, roas: gROAS },
    amazon: { spend: aSpend, revenue: aRevenue, roas: aROAS },
    email: { revenue: eRevenue }
  };
}
```

**Tool loop**

> Google ads: spend $2,199.09, revenue $6,806.18, ROAS 3.095. Amazon ads: spend $477.57, revenue $1,089.98, ROAS 2.282. Email revenue: $20,243.41. All figures from September 2026 data.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The salon service that brought in the most revenue in September was completed appointments with $44,233.45. There were 5 no-shows.

Numbers not in the data: "$44,233.45" is not in the facts

Script the model wrote:

```js
async () => { const m = await codemode.get_finance_metrics({ period: "2026-09" }); const r = await codemode.get_timeline({ limit: 100 }); const s = m.metrics; let top = ""; let topVal = -1; for (const [id, v] of Object.entries(s)) { if (v.business === "salon" && v.unit === "usd" && v.value > topVal) { topVal = v.value; top = v.label; } } const noShows = s["m:salon.no_shows.count"]?.value ?? 0; return { topService: top, topServiceRevenue: topVal, noShows }; }
```

**Tool loop**

> The top salon service was cut and style at $11,347.46 revenue, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest proposal cites metrics 101, 102, and 103 with values 4.2%, 3.8%, and 5.1% respectively. No one has declined an ads plan before.

Numbers not in the data: "101" is not in the facts; "102" is not in the facts; "103" is not in the facts; "4.2%" is not in the facts; "3.8%" is not in the facts; "5.1%" is not in the facts

Script the model wrote:

```js
async () => {
  const latest = await codemode.latest_proposal({});
  const explain = await codemode.explain_proposal({ proposal: latest?.proposal?.id });
  const decisions = await codemode.recall_decisions({ assistant: "online", query: "ads plan", limit: 20 });

  return {
    latestProposalId: latest?.proposal?.id,
    createdAt: latest?.proposal?.createdAt,
    titles: latest?.proposal?.titles,
    citedMetricIds: latest?.proposal?.citedMetricIds,
    decided: latest?.proposal?.decided,
    proposalDetails: explain?.proposal,
    citedMetrics: explain?.cited?.map(c => ({ id: c.id, label: c.label, value: c.value, unit: c.unit, business: c.business })) || [],
    adsPlanDeclinedBefore: decisions.decisions.some(d => d.text.toLowerCase().includes("ads") && /decline|no|reject/.test(d.text.toLowerCase()))
  };
}
```

**Tool loop**

> No latest proposal found. No prior ad plan declines recorded.

