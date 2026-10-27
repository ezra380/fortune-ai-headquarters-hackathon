# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 8 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`, `explain_proposal`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.
Code Mode's reply step works as the worker's does: when a number in the reply is not in the script's result, the model gets one correction round (its tokens are counted).

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 3 | 5,253 | 558 | 5,811 | 2 | 10.1 | yes | 1 of 7 |
| Q1 | Tool loop | yes | 6 | 28,156 | 220 | 28,376 | 4 | 24.8 | yes | 7 of 7 |
| Q2 | Code Mode | yes | 2 | 2,770 | 243 | 3,013 | 2 | 13.4 | no (2) | 0 of 3 |
| Q2 | Tool loop | yes | 6 | 23,208 | 163 | 23,371 | 3 | 10.5 | yes | 3 of 3 |
| Q3 | Code Mode | no | 2 | 4,566 | 429 | 4,995 | 2 | 11.4 | no answer | n/a |
| Q3 | Tool loop | no | 1 | 0 | 0 | 0 | 0 | 0.0 | no answer | n/a |
| **All** | **Code Mode** | 2 of 3 | 7 | 12,589 | 1,230 | 13,819 | 6 | 34.8 | | |
| **All** | **Tool loop** | 2 of 3 | 13 | 51,364 | 383 | 51,747 | 7 | 35.3 | | |

## Code Mode against the tool loop

- Total tokens: 73.3% fewer
- Input tokens: 75.5% fewer
- Output tokens: 221.1% more
- Model calls: 46.2% fewer
- Wall time: 1.5% fewer

A run that gave no answer still counts its tokens, so the comparison above is not like for like.

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> I don't have the Google or Amazon ad data for September. I only have the email revenue of $20,243.41.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const g = finance.metrics["m:online.ads.google"];
  const a = finance.metrics["m:online.ads.amazon"];
  const e = finance.metrics["m:online.email.revenue"];
  return {
    googleSpend: g?.value ?? null,
    googleRevenue: g?.business === "online" ? finance.metrics["m:online.ads.google.revenue"]?.value ?? null : null,
    googleROAS: g?.business === "online" ? finance.metrics["m:online.ads.google.roas"]?.value ?? null : null,
    amazonSpend: a?.value ?? null,
    amazonRevenue: a?.business === "online" ? finance.metrics["m:online.ads.amazon.revenue"]?.value ?? null : null,
    amazonROAS: a?.business === "online" ? finance.metrics["m:online.ads.amazon.roas"]?.value ?? null : null,
    emailRevenue: e?.value ?? null
  };
}
```

**Tool loop**

> Google ad spend $2,199.09, revenue $6,806.18, ROAS 3.095. Amazon ad spend $477.57, revenue $1,089.98, ROAS 2.2823. Email revenue $20,243.41. All figures for September 2026.

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

**Code Mode**

> The salon service that brought in the most revenue in September was all completed appointments with $44,233.45. There were 0 no-shows.

Numbers not in the data: "$44,233.45" is not in the facts; "0" is not in the facts

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const salonMetrics = finance.metrics;
  let topService = null;
  let topRevenue = -1;
  for (const [id, m] of Object.entries(salonMetrics)) {
    if (m.business === "salon" && m.unit === "usd" && m.value > topRevenue) {
      topRevenue = m.value;
      topService = m.label;
    }
  }
  const timeline = await codemode.get_timeline({ limit: 1 });
  let noShows = 0;
  if (timeline.events && timeline.events.length > 0) {
    for (const e of timeline.events) {
      if (e.type === "no_show") {
        noShows++;
      }
    }
  }
  return { topService, topRevenue, noShows };
}
```

**Tool loop**

> The salon service with the most revenue in September was cut and style at $11,347.46, and there were 5 no-shows.

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode** (no answer: the script did not give a usable answer: cannot read property 'id' of null)

Script the model wrote:

```js
async () => {
  const latest = await codemode.latest_proposal({});
  if (!latest) return { latest_proposal: null, ads_declined: false };

  const explain = await codemode.explain_proposal({ proposal: latest.proposal.id });
  if (!explain) return { latest_proposal: latest, ads_declined: false };

  const citedMetrics = explain.cited.map(c => ({ id: c.id, label: c.label, value: c.value, unit: c.unit, business: c.business }));

  const adsDecisions = await codemode.recall_decisions({ assistant: "owner", query: "ads plan declined", limit: 20 });
  const declined = adsDecisions.decisions.some(d => /decline|\bno\b/.test(d.text.toLowerCase()));

  return { latest_proposal: latest, citedMetrics, ads_declined: declined };
}
```

**Tool loop** (no answer: nvidia returned HTTP 502; response body withheld)

