# Runbook: take the demo live

Steps marked **(owner)** need the owner's own sign-in, money or secrets. Agents never paste secrets into
chat, commit them, or print them. Everything else can be run by an agent.

## 1. Cloud database and SMS webhook (Supabase)

1. **(owner)** Create a free Supabase project, e.g. `fortune-ai-hq-demo`. Put its Project URL and
   `service_role` key in `.env.local` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
2. **(owner)** `npx supabase login` (opens the browser once).
3. Link and apply the schema and the synthetic seed:
   ```bash
   npx supabase link --project-ref <project-ref>
   npx supabase db push --include-seed
   ```
4. **(owner)** Set the function's secrets. Type them yourself; never into chat:
   ```bash
   npx supabase secrets set TWILIO_AUTH_TOKEN=<auth token> \
     TWILIO_WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/inbound
   ```
5. Deploy the webhook. It verifies Twilio's signature itself, so Supabase's JWT check is off for this
   function only:
   ```bash
   npx supabase functions deploy inbound --no-verify-jwt
   ```

## 2. Two assistant numbers (Twilio)

1. **(owner)** In the Console, open the **empty** registered "Low Volume Mixed A2P Messaging Service".
   Confirm its campaign is approved and read its description. Never touch the service that holds the
   929 and 347 lines.
2. **(owner)** Buy two local numbers (owner's assistant, finance assistant) and add both to that empty
   service. The service defers to each number's own webhook.
3. **(owner)** On each new number, set "A message comes in" → Webhook → HTTP POST →
   `https://<project-ref>.supabase.co/functions/v1/inbound`.
4. **(owner)** Create a dedicated API key for this demo. In `.env.local` set:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`;
   - `TWILIO_FROM_OWNER_ASSISTANT`, `TWILIO_FROM_FINANCE_ASSISTANT`;
   - `DEMO_OWNER_PHONE`, `DEMO_FINANCE_PHONE` (and names if wanted).

   Revoke the key after the event.
5. Register the people and numbers on the cloud database:
   ```bash
   npx tsx scripts/register-demo-phones.ts
   ```

## 3. Run

```bash
npm run worker            # keeps running; Ctrl+C stops it
```

Text the owner's assistant number from the owner's phone. Watch receipts in the `receipts` table, or in the
console once lane B ships it.

## Rollback

- Stop the worker.
- Remove the two numbers' webhooks (or release the numbers).
- Revoke the demo API key.
- Delete the demo Supabase project.

Nothing here touches the business's live systems.
