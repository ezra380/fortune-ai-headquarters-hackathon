// Registers the real demo phones and assistant numbers on the Supabase project in SUPABASE_URL.
// Phone numbers are personal data: they come only from .env.local, are never committed, and are
// printed masked. Usage: npx tsx scripts/register-demo-phones.ts
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envFile = path.resolve(import.meta.dirname, '../.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const phone = /^\+1\d{10}$/;
const mask = (p: string) => `…${p.slice(-4)}`;

const people = [
  { id: 'demo-p-owner', phone: env.DEMO_OWNER_PHONE, name: env.DEMO_OWNER_NAME },
  { id: 'demo-p-finance-owner', phone: env.DEMO_FINANCE_PHONE, name: env.DEMO_FINANCE_NAME },
];
const assistants = [
  { id: 'owner', sms_from: env.TWILIO_FROM_OWNER_ASSISTANT },
  { id: 'finance', sms_from: env.TWILIO_FROM_FINANCE_ASSISTANT },
  { id: 'online', sms_from: env.TWILIO_FROM_ONLINE_ASSISTANT },
];

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
for (const p of people) if (p.phone && !phone.test(p.phone)) throw new Error(`The phone for ${p.id} must look like +1XXXXXXXXXX`);
for (const a of assistants) if (a.sms_from && !phone.test(a.sms_from)) throw new Error(`Assistant number for ${a.id} must look like +1XXXXXXXXXX`);

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const p of people) {
  if (!p.phone) {
    console.log(`skipped ${p.id}: no phone in .env.local yet (keeps the synthetic number)`);
    continue;
  }
  const { error } = await db.from('people').update({ phone: p.phone, ...(p.name ? { name: p.name } : {}) }).eq('id', p.id);
  if (error) throw new Error(`Could not register ${p.id} (${error.code ?? 'db'})`);
  console.log(`registered ${p.id} → ${mask(p.phone!)}`);
}
for (const a of assistants) {
  if (!a.sms_from) continue;
  const { error } = await db.from('assistants').update({ sms_from: a.sms_from }).eq('id', a.id);
  if (error) throw new Error(`Could not set the number for ${a.id} (${error.code ?? 'db'})`);
  console.log(`assistant ${a.id} texts from ${mask(a.sms_from)}`);
}
