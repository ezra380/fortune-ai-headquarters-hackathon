# Demo video script (rule 6.1: 1 to 4 minutes), DRAFT

Target 3 minutes. Screen recording of two phones (or the Twilio console log), the terminal and the Admin
console. Name Zetaris and Meterless on screen where each acts.

| Time | On screen | Voice |
|---|---|---|
| 0:00 | Title card | "A family business that is really two: a salon and an online store. Three owners, separate books. This is an assistant per person, and an agent that can explain why." |
| 0:15 | Owner's phone: the request text; the instant reply | "I text my assistant. The webhook stores the task once and answers in about a second. No AI runs in the webhook." |
| 0:35 | Terminal: worker log, router decision | "NVIDIA Nemotron Lightning routes it to the finance assistant." |
| 0:50 | Zetaris UI: the three source databases and `fortune_hq.finance_metrics` | "**Zetaris** federates three separately owned sources into one governed view. Bad rows are filtered and counted, never hidden." |
| 1:15 | Terminal: plans passing validation; one rejected attempt if recorded | "Nemotron Ultra writes three plans. A validator checks every number against the Zetaris metrics. A plan that invents a number never reaches me." |
| 1:45 | The PDF: one plan's evidence with metric ids and the query hash | "Every figure traces to a metric, a computed projection, or a setting it proposes." |
| 2:05 | Owner's phone: `SEND 2 <code>`; finance owner's phone: the plan, then `CONFIRM <code>` | "I forward plan 2 with a one-time code. The finance owner confirms with his own code. A plain 'yes' never counts." |
| 2:30 | Admin console: Finance tab, approvals, memory | "**Meterless**: the World Model records who asked, which numbers, which plan and who decided. H-MEM keeps only what a person decided as long-term memory." |
| 2:50 | Claude Code calling the brain through Code Mode | "Any AI tool reads the same brain through one sandboxed Code Mode tool." |
| 3:05 | End card: repo link, synthetic-data note | "All data here is synthetic. The code is open." |
