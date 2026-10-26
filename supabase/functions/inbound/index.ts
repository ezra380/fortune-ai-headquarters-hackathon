// Supabase Edge Function: Twilio SMS webhook. It verifies the signature, stores the text once,
// queues one task for a known sender and answers within about a second. It never calls a model.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ACK_TEXT, RETRY_TEXT, isValidTwilioRequest, parseInbound, twiml } from './lib.ts';

const env = (name: string): string => Deno.env.get(name) ?? '';
const xml = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });

// One reason code per refusal, never the parameters or a secret.
const refuse = (reason: string, status: number, body: string): Response => {
  console.warn(`inbound.refused ${reason}`);
  return new Response(body, { status });
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return refuse('method', 405, 'Method not allowed');
  if (Number(req.headers.get('content-length') ?? '0') > 20_000) return refuse('too_large', 413, 'Payload too large');
  const raw = await req.text();
  if (raw.length > 20_000) return refuse('too_large', 413, 'Payload too large');
  const params = Object.fromEntries(new URLSearchParams(raw));

  // TWILIO_WEBHOOK_URL is the exact public URL configured on the Twilio number; Twilio signs it.
  const signed = await isValidTwilioRequest(
    env('TWILIO_AUTH_TOKEN'),
    env('TWILIO_WEBHOOK_URL'),
    params,
    req.headers.get('x-twilio-signature'),
  );
  if (!signed) return refuse('signature', 403, 'Forbidden');

  const sms = parseInbound(params);
  if (!sms) {
    console.warn('inbound.ignored keyword_or_malformed');
    return xml(twiml());
  }

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc('enqueue_inbound_text', {
    p_message_sid: sms.messageSid,
    p_from: sms.from,
    p_to: sms.to,
    p_body: sms.body,
  });
  if (error) {
    // Twilio does not retry a 5xx on its own, so the sender is told; nothing was stored.
    console.error('inbound.enqueue_failed', error.code ?? 'unknown');
    return xml(twiml(RETRY_TEXT));
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { task_id: string | null; outcome: string; duplicate: boolean }
    | undefined;
  // Unknown senders and Twilio retries get an empty reply: no engagement, no double acknowledgement.
  if (!row || row.outcome !== 'queued' || row.duplicate) return xml(twiml());
  return xml(twiml(ACK_TEXT));
});
