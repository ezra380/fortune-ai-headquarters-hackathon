# Code Mode against tool calling: measured 2026-10-27 (LIVE)

**LIVE run.** Real NVIDIA model calls and the real read tools. Nothing was sent to anyone and nothing was written except this report.
Both arms used model `nvidia/nemotron-3.5-lightning-30b-a3b`, the skill `fortune-hq-owner` and the same 7 read tools (`get_finance_metrics`, `recall_decisions`, `list_lessons`, `get_timeline`, `open_items`, `latest_proposal`, `usage_summary`).
Tokens are the provider-reported counts. Each question ran once per arm, so one run is a sample, not an average.

| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |
|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | Code Mode | yes | 2 | 1,806 | 277 | 2,083 | 1 | 9.4 | yes | 0 of 7 |
| Q1 | Tool loop | no | 6 | 21,864 | 155 | 22,019 | 4 | 16.6 | no answer | n/a |
| Q2 | Code Mode | yes | 2 | 1,777 | 245 | 2,022 | 1 | 6.1 | not checked (oracle unavailable) | n/a |
| Q2 | Tool loop | no | 6 | 17,951 | 142 | 18,093 | 5 | 17.8 | no answer | n/a |
| Q3 | Code Mode | yes | 2 | 1,758 | 228 | 1,986 | 3 | 6.1 | yes | n/a |
| Q3 | Tool loop | no | 6 | 7,472 | 84 | 7,556 | 6 | 2.4 | no answer | n/a |
| **All** | **Code Mode** | 3 of 3 | 6 | 5,341 | 750 | 6,091 | 5 | 21.6 | | |
| **All** | **Tool loop** | 0 of 3 | 18 | 47,287 | 381 | 47,668 | 15 | 36.8 | | |

## Code Mode against the tool loop

- Total tokens: 87.2% fewer
- Input tokens: 88.7% fewer
- Output tokens: 96.9% more
- Model calls: 66.7% fewer
- Wall time: 41.4% fewer

A run that gave no answer still counts its tokens, so the comparison above is not like for like.

## Per question

### Q1. How did Google and Amazon ads do in September compared with email revenue? Give spend, revenue and ROAS.

**Code Mode**

> I don't have the September ad or email data. Please provide the numbers or check the finance metrics.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const metrics = finance.metrics;
  const get = (label) => metrics.find((m) => m.label === label);
  const spendGoogle = get("Google Ads Spend")?.value ?? 0;
  const revenueGoogle = get("Google Ads Revenue")?.value ?? 0;
  const roasGoogle = get("Google Ads ROAS")?.value ?? null;
  const spendAmazon = get("Amazon Ads Spend")?.value ?? 0;
  const revenueAmazon = get("Amazon Ads Revenue")?.value ?? 0;
  const roasAmazon = get("Amazon Ads ROAS")?.value ?? null;
  const spendEmail = get("Email Revenue")?.value ?? 0;
  const revenueEmail = get("Email Revenue")?.value ?? 0;
  const roasEmail = get("Email ROAS")?.value ?? null;
  return {
    spendGoogle,
    revenueGoogle,
    roasGoogle,
    spendAmazon,
    revenueAmazon,
    roasAmazon,
    spendEmail,
    revenueEmail,
    roasEmail,
  };
}
```

**Tool loop** (no answer: no answer after 6 rounds)

### Q2. Which salon service brought in the most revenue in September, and how many no-shows were there?

The oracle could not be read, so numbers were not checked: listen EADDRINUSE: address already in use 127.0.0.1:18120

**Code Mode**

> The salon service that brought in the most revenue in September was haircuts with $44,233.45. There were 5 no-shows.

Script the model wrote:

```js
async () => {
  const finance = await codemode.get_finance_metrics({ period: "2026-09" });
  const metrics = finance.view === "combined" ? finance.metrics : finance.metrics.filter(m => m.business === "salon");

  // Find the service with the highest revenue value
  let topService = null;
  let topValue = -1;
  for (const m of metrics) {
    if (m.value > topValue) {
      topValue = m.value;
      topService = m.label;
    }
  }

  // Look for no-show count in the metrics
  let noShows = null;
  for (const m of metrics) {
    if (m.label.toLowerCase().includes("no-show") || m.label.toLowerCase().includes("no show")) {
      noShows = m.value;
      break;
    }
  }

  return {
    topService,
    topValue,
    noShows
  };
}
```

**Tool loop** (no answer: no answer after 6 rounds)

### Q3. What did the latest finance proposal cite, and has anyone declined an ads plan before?

**Code Mode**

> The latest finance proposal cited no metrics. No one has declined an ads plan before.

Script the model wrote:

```js
async () => {
  const latest = await codemode.latest_proposal({});
  const metrics = await codemode.get_finance_metrics({ period: "2026-10-mtd" });
  const declined = await codemode.recall_decisions({ assistant: "owner", query: "ads plan", limit: 20 });

  const citedLabels = latest?.proposal?.citedMetricIds?.map(id => {
    const m = metrics.metrics.find(x => x.id === id);
    return m ? `${m.label}: ${m.value} ${m.unit}` : id;
  }) || [];

  return {
    latestProposalId: latest?.proposal?.id,
    createdAt: latest?.proposal?.createdAt,
    citedMetricLabels: citedLabels,
    anyoneDeclinedAdsPlan: declined.decisions.some(d => d.text.toLowerCase().includes("ads") && /decline|no|reject/.test(d.text))
  };
}
```

**Tool loop** (no answer: no answer after 6 rounds)

