# Slide deck outline (rule 6.2), DRAFT

Eight slides. One idea per slide; the numbers on slides 5 and 6 are copied from the recorded runs.

1. **Fortune AI Headquarters.** "The agent that can explain why." A company brain and an assistant per
   person for a family business that is really two businesses.
2. **The problem.** A salon and an online store, three owners, separate books. Ideas travel by phone and
   memory; nobody can later say why a decision was made, on which numbers, or whether it was tried before.
3. **The users.** The online owner (his assistant), the finance owner (his assistant, by text), the head
   stylist (Cindy, her own app; shown as a placeholder tab). Each has their own number and an instant reply.
4. **The workflow.** Diagram: text → webhook (instant "working on it") → front door (Nemotron Lightning) →
   finance assistant → Zetaris view + H-MEM decisions → Nemotron Ultra → validator → PDF + text →
   `SEND n code` → `CONFIRM code` → World Model + long-term memory.
5. **Zetaris: federated, governed, proven.** Three source databases, one view, data-quality rules with a
   visible rejected-rows metric, 33 metrics per period, live answer = independent computation (33/33).
6. **Every number traces.** One plan with its evidence (metric id, value, Zetaris query hash), one
   projection (metric × factor), one declared proposed setting. A rejected plan with the validator's reason.
7. **Meterless: record and memory.** World Model timeline of one decision; H-MEM showing a proposal
   ("unapproved", short-term) superseded by a person's decision (long-term). Code Mode: any AI tool reads
   the same brain with one sandboxed `code` call.
8. **Stack and what's next.** Supabase (queue, approvals, outbox), Twilio, Zetaris, Meterless, NVIDIA
   Nemotron, Cloudflare Code Mode. Next, as planned and not built: the four assistants inside the owner's
   operations hub, and Cindy's backend mirrored in the Admin console.
