# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 2,781 | 357 | 3,138 | 1 | 8.1 | yes | 7 of 7 |
| Q1 | Tool loop | yes | 6 | 27,404 | 204 | 27,608 | 4 | 16.3 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,724 | 246 | 2,970 | 1 | 5.8 | no (1) | 0 of 3 |
| Q2 | Tool loop | yes | 6 | 32,571 | 164 | 32,735 | 5 | 17.4 | yes | 3 of 3 |
| Q3 | Code Mode | yes | 2 | 2,741 | 237 | 2,978 | 3 | 3.3 | yes | n/a |
| Q3 | Tool loop | yes | 6 | 13,012 | 87 | 13,099 | 5 | 6.0 | yes | n/a |
| **All** | **Code Mode** | 3 of 3 | 6 | 8,246 | 840 | 9,086 | 5 | 17.2 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 72,987 | 455 | 73,442 | 14 | 39.8 | | |

## Code Mode against the tool loop

- Total tokens: 87.6% fewer
- Input tokens: 88.7% fewer
- Output tokens: 84.6% more
- Model calls: 66.7% fewer
- Wall time: 56.9% fewer

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> Google: $2,199.09 spend, $6,806.18 revenue, 3.095 ROAS. Amazon: $477.57 spend, $1,089.98 revenue, 2.2823 ROAS. Email revenue: $20,243.41.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const google = finance.metrics.find(m => m.id === "m:online.ads.google.spend");
  const googleRev = finance.metrics.find(m => m.id === "m:online.ads.google.revenue");
  const googleRoas = finance.metrics.find(m => m.id === "m:online.ads.google.roas");
  const amazon = finance.metrics.find(m => m.id === "m:online.ads.amazon.spend");
  const amazonRev = finance.metrics.find(m => m.id === "m:online.ads.amazon.revenue");
  const amazonRoas = finance.metrics.find(m => m.id === "m:online.ads.amazon.roas");
  const emailRev = finance.metrics.find(m => m.id === "m:online.email.revenue");

  return {
    googleSpend: google?.value,
    googleRevenue: googleRev?.value,
    googleRoas: googleRoas?.value,
    amazonSpend: amazon?.value,
    amazonRevenue: amazonRev?.value,
    amazonRoas: amazonRoas?.value,
    emailRevenue: emailRev?.value
  };
}
```

**Tool loop**

> Google ad spend $2,199.09, revenue $6,806.18, ROAS 3.10. Amazon ad spend $477.57, revenue $1,089.98, ROAS 2.28. Email revenue $20,243.41.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The top salon service in September generated $44,233.45 in revenue. No-show data was not available.

Numbers not in the data: "$44,233.45" is not in the facts

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const metrics = finance.metrics;
  const serviceRevenue = metrics.filter(m => m.business === "salon" && !m.label.includes("revenue.total") && !m.label.includes("appointments.count") && !m.label.includes("no_shows") && !m.label.includes("avg_ticket") && !m.label.includes("rejected"));
  let topService = null;
  let topValue = -1;
  for (const m of serviceRevenue) {
    if (m.value > topValue) {
      topValue = m.value;
      topService = m.label;
    }
  }
  const noShows = metrics.find(m => m.label.includes("no_shows"));
  return {
    topService: topService || "none found",
    topServiceRevenue: topValue,
    noShows: noShows ? noShows.value : null
  };
}
```

**Tool loop**

> The salon service with the most revenue in September was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest proposal has no plans or metrics cited. No one has declined an ads plan before.

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
    proposalExplanation: explain,
    priorAdsDecline: decisions.decisions.find(d => d.text.toLowerCase().includes("decline") || d.text.toLowerCase().includes("reject")),
    adsDeclineHistory: decisions.decisions.filter(d => /ad(s| plan)/i.test(d.text) && /decline|reject/i.test(d.text))
  };
}
```

**Tool loop**

> No latest proposal found. No prior ads plan declines recorded.

