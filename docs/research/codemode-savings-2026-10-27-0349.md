# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 2,793 | 357 | 3,150 | 1 | 8.3 | yes | 7 of 7 |
| Q1 | Tool loop | yes | 6 | 32,655 | 223 | 32,878 | 5 | 16.9 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,736 | 314 | 3,050 | 1 | 7.1 | no (1) | 2 of 3 |
| Q2 | Tool loop | yes | 6 | 32,643 | 164 | 32,807 | 5 | 16.4 | yes | 3 of 3 |
| Q3 | Code Mode | yes | 2 | 2,768 | 192 | 2,960 | 3 | 3.6 | no (2) | n/a |
| Q3 | Tool loop | yes | 6 | 13,084 | 87 | 13,171 | 5 | 2.1 | yes | n/a |
| **All** | **Code Mode** | 3 of 3 | 6 | 8,297 | 863 | 9,160 | 5 | 18.9 | | |
| **All** | **Tool loop** | 3 of 3 | 18 | 78,382 | 474 | 78,856 | 15 | 35.4 | | |

## Code Mode against the tool loop

- Total tokens: 88.4% fewer
- Input tokens: 89.4% fewer
- Output tokens: 82.1% more
- Model calls: 66.7% fewer
- Wall time: 46.6% fewer

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

> Google ads: spend $2,199.09, revenue $6,806.18, ROAS 3.095. Amazon ads: spend $477.57, revenue $1,089.98, ROAS 2.282. Email revenue: $20,243.41. All for September 2026.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The salon service with the most revenue in September was cut and style, bringing in $11,347.46. There were 0 no-shows recorded for that month.

Numbers not in the data: "0" is not in the facts

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const metrics = finance.metrics;
  const revenueByService = {};
  let totalNoShows = 0;

  for (const m of metrics) {
    const label = m.label.toLowerCase();
    if (label.includes("wash set") || label.includes("cut and style") || label.includes("repair") || label.includes("consignment intake") || label.includes("color") || label.includes("fortune appointment")) {
      revenueByService[m.label] = (revenueByService[m.label] || 0) + m.value;
    }
    if (m.label === "no-shows") {
      totalNoShows += m.value;
    }
  }

  let topService = null;
  let topRevenue = -1;
  for (const [label, rev] of Object.entries(revenueByService)) {
    if (rev > topRevenue) {
      topRevenue = rev;
      topService = label;
    }
  }

  return {
    topRevenueService: topService || "no salon revenue data",
    topRevenue: topRevenue,
    noShows: totalNoShows
  };
}
```

**Tool loop**

> The salon service with the most revenue in September was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest proposal cited salon revenue of $12,450 and online revenue of $8,320 for the period. No one has declined an ads plan before.

Numbers not in the data: "$12,450" is not in the facts; "$8,320" is not in the facts

Script the model wrote:

```js
async () => {
  const latest = await codemode.latest_proposal({});
  const explain = await codemode.explain_proposal({ proposal: latest?.proposal?.id });
  const decisions = await codemode.recall_decisions({ assistant: "online", query: "ads plan", limit: 10 });

  return {
    latestProposal: latest?.proposal,
    proposalExplanation: explain,
    adsPlanDeclinedBefore: decisions.decisions.some(d => d.text.toLowerCase().includes("decline") && d.text.toLowerCase().includes("ads")),
    recentAdsDecisions: decisions.decisions.filter(d => d.text.toLowerCase().includes("ads"))
  };
}
```

**Tool loop**

> No latest proposal found. No prior ads plan declines recorded.

