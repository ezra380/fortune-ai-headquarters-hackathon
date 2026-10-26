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
   Twilio signs every webhook with the **account's** Auth Token; an API key cannot verify signatures.
   That token is shared with every other webhook on the account (the 929 ticketing line's included),
   so rotating it means updating all of them at the same time.
5. Deploy the webhook. It verifies Twilio's signature itself, so Supabase's JWT check is off for this
   function only:
   ```bash
   npx supabase functions deploy inbound --no-verify-jwt
   ```

## 2. Two assistant numbers (Twilio)

1. **(owner)** In the Console, open the **empty** registered "Low Volume Mixed A2P Messaging Service".
   Confirm its campaign is approved and read its description. Never touch the service that holds the
   929 and 347 lines.
2. **(owner)** Buy one local number per assistant (owner, finance, online customer service) and add them
   to that service. The service defers to each number's own webhook.
3. **(owner)** On each new number, set "A message comes in" → Webhook → HTTP POST →
   `https://<project-ref>.supabase.co/functions/v1/inbound`.
4. **(owner)** Create a dedicated API key for this demo. In `.env.local` set:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`;
   - `TWILIO_FROM_OWNER_ASSISTANT`, `TWILIO_FROM_FINANCE_ASSISTANT`, `TWILIO_FROM_ONLINE_ASSISTANT`;
   - `DEMO_OWNER_PHONE`, `DEMO_FINANCE_PHONE` (and names if wanted).

   Revoke the key after the event.
5. Register the people and numbers on the cloud database:
   ```bash
   npx tsx scripts/register-demo-phones.ts
   ```

## 3. Business numbers (Zetaris)

1. **(owner)** Install and start Zetaris locally (its `getting-started` guide); put the `ZETARIS_*`
   settings in `.env.local`.
2. Create the three source databases, the views and the governed finance view, then prove the view equals
   an independent computation for both periods:
   ```bash
   npm run zetaris:setup
   ```
   The synthetic source API (port 18120) is started by the worker when it needs numbers; Zetaris reaches
   it at `host.docker.internal:18120`.

## 4. Run

```bash
npm run worker            # keeps running; Ctrl+C stops it
npm run console           # the owner's read-only Admin console at http://127.0.0.1:5180
```

Text the owner's assistant number from the owner's phone. Watch the departments in the console, or the
`receipts` table.

## Rollback

- Stop the worker.
- Remove the numbers' webhooks (or release the numbers).
- Revoke the demo API key.
- `npx supabase secrets unset TWILIO_AUTH_TOKEN` on this project. Rotate the account's Auth Token only
  together with every other webhook that uses it (see step 1.4).
- Delete the demo Supabase project, or keep it if it goes on to live use.

Nothing here touches the business's live systems.
