# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.
Code Mode's reply step works as the worker's does: when a number in the reply is not in the script's result, the model gets one correction round (its tokens are counted).
Code Mode's script step: reasoning ON. The tool loop runs with reasoning off.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 2,825 | 1,841 | 4,666 | 1 | 25.9 | yes | 7 of 7 |
| Q1 | Tool loop | yes | 6 | 26,922 | 248 | 27,170 | 3 | 16.6 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,767 | 2,482 | 5,249 | 1 | 35.1 | yes | 3 of 3 |
| Q2 | Tool loop | yes | 6 | 29,378 | 197 | 29,575 | 4 | 16.1 | yes | 3 of 3 |
| Q3 | Code Mode | yes | 2 | 2,752 | 2,257 | 5,009 | 3 | 42.8 | yes | n/a |
| Q3 | Tool loop | yes | 6 | 13,198 | 87 | 13,285 | 5 | 4.5 | yes | n/a |
| **All** | **Code Mode** | 3 of 3 | 6 | 8,344 | 6,580 | 14,924 | 5 | 103.7 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 69,498 | 532 | 70,030 | 12 | 37.3 | | |

## Code Mode against the tool loop

- Total tokens: 78.7% fewer
- Input tokens: 88.0% fewer
- Output tokens: 1136.8% more
- Model calls: 66.7% fewer
- Wall time: 178.5% more

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> Google: spend $2,199.09, revenue $6,806.18, ROAS 3.10. Amazon: spend $477.57, revenue $1,089.98, ROAS 2.28. Email revenue: $20,243.41.

Script the model wrote:

```js
async () => {
  const r = await codemode.get_finance_metrics({ period: "2026-09" });
  if (!r || !r.metrics) return {};
  const m = r.metrics;
  const googleSpend = m["m:online.ads.google.spend"]?.value;
  const googleRevenue = m["m:online.ads.google.revenue"]?.value;
  const googleRoas = m["m:online.ads.google.roas"]?.value;
  const amazonSpend = m["m:online.ads.amazon.spend"]?.value;
  const amazonRevenue = m["m:online.ads.amazon.revenue"]?.value;
  const amazonRoas = m["m:online.ads.amazon.roas"]?.value;
  const emailRevenue = m["m:online.email.revenue"]?.value;
  return {
    googleSpend,
    googleRevenue,
    googleRoas,
    amazonSpend,
    amazonRevenue,
    amazonRoas,
    emailRevenue
  };
}
```

**Tool loop**

> Google ads: spend $2,199.09, revenue $6,806.18, ROAS 3.10. Amazon ads: spend $477.57, revenue $1,089.98, ROAS 2.28. Email revenue: $20,243.41. All figures for September 2026.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The salon service that brought in the most revenue in September was cut and style with $11,347.46. There were 5 no-shows.

Script the model wrote:

```js
async () => {
  const r = await codemode.get_finance_metrics({ period: "2026-09" });
  if (!r || !r.metrics) return { error: "no metrics returned" };
  const m = r.metrics;
  const serviceIds = [
    "m:salon.revenue.wash_set",
    "m:salon.revenue.cut_style",
    "m:salon.revenue.repair",
    "m:salon.revenue.consignment_intake",
    "m:salon.revenue.color",
    "m:salon.revenue.fortune_appointment"
  ];
  let topLabel = "";
  let topVal = -1;
  for (const id of serviceIds) {
    const met = m[id];
    if (!met) continue;
    if (met.value > topVal) {
      topVal = met.value;
      topLabel = met.label;
    }
  }
  const ns = m["m:salon.no_shows.count"];
  const noShows = ns ? ns.value : 0;
  return {
    topService: topLabel || "none",
    topServiceRevenue: topVal,
    noShows: noShows
  };
}
```

**Tool loop**

> The salon service with the most revenue in September was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest proposal cited no metrics. No one has declined an ads plan before.

Script the model wrote:

```js
async () => {
  const latest = await codemode.latest_proposal({});
  const explain = await codemode.explain_proposal({});
  const decisions = await codemode.recall_decisions({ assistant: "owner", query: "ads plan declined" });
  
  const citedMetrics = explain?.cited || [];
  const anyDeclinedAdsPlan = decisions?.decisions?.some(
    d => d.text.toLowerCase().includes("declined") && d.text.toLowerCase().includes("ads")
  ) ? true : false;
  
  return {
    latestProposalId: latest.proposal?.id,
    proposedAt: latest.proposal?.createdAt,
    planTitles: latest.proposal?.titles,
    citedMetricCount: citedMetrics.length,
    citedMetrics: citedMetrics.map(m => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business })),
    anyDeclinedAdsPlan
  };
}
```

**Tool loop**

> No latest proposal found. No prior ad plan declines recorded.

