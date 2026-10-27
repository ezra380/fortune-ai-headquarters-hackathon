# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.
Code Mode's reply step works as the worker's does: when a number in the reply is not in the script's result, the model gets one correction round (its tokens are counted).
Code Mode's script step: reasoning ON. The tool loop runs with reasoning off.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 2,825 | 1,642 | 4,467 | 1 | 37.0 | yes | 7 of 7 |
| Q1 | Tool loop | yes | 6 | 29,390 | 248 | 29,638 | 4 | 30.5 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,769 | 2,322 | 5,091 | 1 | 33.3 | no (1) | 1 of 3 |
| Q2 | Tool loop | yes | 6 | 28,144 | 240 | 28,384 | 3 | 27.8 | yes | 3 of 3 |
| Q3 | Code Mode | yes | 3 | 3,424 | 2,839 | 6,263 | 6 | 35.0 | no (3) | n/a |
| Q3 | Tool loop | yes | 6 | 13,198 | 87 | 13,285 | 5 | 2.5 | yes | n/a |
| **All** | **Code Mode** | 3 of 3 | 7 | 9,018 | 6,803 | 15,821 | 8 | 105.3 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 70,732 | 575 | 71,307 | 12 | 60.9 | | |

## Code Mode against the tool loop

- Total tokens: 77.8% fewer
- Input tokens: 87.3% fewer
- Output tokens: 1083.1% more
- Model calls: 61.1% fewer
- Wall time: 72.9% more

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> Google: spend $2,199.09, revenue $6,806.18, ROAS 3.10. Amazon: spend $477.57, revenue $1,089.98, ROAS 2.28. Email revenue $20,243.41.

Script the model wrote:

```js
async () => {
  const r = await codemode.get_finance_metrics({ period: "2026-09" });
  const m = r.metrics;
  return {
    googleSpend: m["m:online.ads.google.spend"]?.value,
    googleRevenue: m["m:online.ads.google.revenue"]?.value,
    googleRoAS: m["m:online.ads.google.roas"]?.value,
    amazonSpend: m["m:online.ads.amazon.spend"]?.value,
    amazonRevenue: m["m:online.ads.amazon.revenue"]?.value,
    amazonRoAS: m["m:online.ads.amazon.roas"]?.value,
    emailRevenue: m["m:online.email.revenue"]?.value
  };
}
```

**Tool loop**

> Google ads: spend $2,199.09, revenue $6,806.18, ROAS 3.095. Amazon ads: spend $477.57, revenue $1,089.98, ROAS 2.282. Email revenue: $20,243.41. All figures for September 2026.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The top salon service in September was all completed appointments with $44,233.45 in revenue. There were 5 no-shows that month.

Numbers not in the data: "$44,233.45" is not in the facts

Script the model wrote:

```js
async () => {
  const r = await codemode.get_finance_metrics({ period: "2026-09" });
  const metrics = r.metrics;
  let maxRevenue = -1;
  let topServiceLabel = null;
  for (const [id, m] of Object.entries(metrics)) {
    if (m.business === "salon" && id.startsWith("m:salon.revenue.")) {
      if (m.value > maxRevenue) {
        maxRevenue = m.value;
        topServiceLabel = m.label;
      }
    }
  }
  const noShowsMetric = metrics["m:salon.no_shows.count"];
  const noShows = noShowsMetric ? noShowsMetric.value : 0;
  return { topService: topServiceLabel, revenue: maxRevenue, noShows };
}
```

**Tool loop**

> The top salon service was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest proposal cited: Customer Acquisition Cost $12.50, Conversion Rate 3.2%, Revenue per Visitor $9.80. No one has declined an ads plan before.

Numbers not in the data: "$12.50" is not in the facts; "3.2%" is not in the facts; "$9.80" is not in the facts

Script the model wrote:

```js
async () => {
  const propInfo = await codemode.explain_proposal({});
  const cited = propInfo.cited || [];
  const metricsSummary = cited.map(c => ({ label: c.label, value: c.value, unit: c.unit, business: c.business }));

  let adsPlanDeclined = false;
  let declineNote = null;
  const assistants = ["owner", "finance", "salon", "online", "manager"];
  for (const a of assistants) {
    const decResult = await codemode.recall_decisions({ assistant: a, query: "ads plan declined" });
    const matching = decResult.decisions.filter(d => d.text.toLowerCase().includes("ads") && d.text.toLowerCase().includes("declined"));
    if (matching.length > 0) {
      adsPlanDeclined = true;
      declineNote = matching[0].text;
      break;
    }
  }

  return {
    latestProposalCitedMetrics: metricsSummary,
    adsPlanDeclinedBefore: adsPlanDeclined,
    declineDetails: declineNote
  };
}
```

**Tool loop**

> No latest proposal found. No prior ad plan declines recorded.

