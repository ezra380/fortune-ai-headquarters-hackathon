import { describe, expect, it } from 'vitest';
import { isValidTwilioRequest, parseInbound, twilioSignature, twiml } from '../lib.ts';

// Twilio's documented example (twilio.com/docs/usage/security).
const exampleUrl = 'https://example.com/myapp.php?foo=1&bar=2';
const exampleParams = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
};

describe('Twilio signature', () => {
  it("matches Twilio's documented example", async () => {
    expect(await twilioSignature('12345', exampleUrl, exampleParams)).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });

  it('rejects a tampered body, a wrong URL, a wrong token and a missing header', async () => {
    const sig = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';
    expect(await isValidTwilioRequest('12345', exampleUrl, exampleParams, sig)).toBe(true);
    expect(await isValidTwilioRequest('12345', exampleUrl, { ...exampleParams, Digits: '9999' }, sig)).toBe(false);
    expect(await isValidTwilioRequest('12345', exampleUrl + '&x=1', exampleParams, sig)).toBe(false);
    expect(await isValidTwilioRequest('54321', exampleUrl, exampleParams, sig)).toBe(false);
    expect(await isValidTwilioRequest('12345', exampleUrl, exampleParams, null)).toBe(false);
    expect(await isValidTwilioRequest('', exampleUrl, exampleParams, sig)).toBe(false);
  });
});

describe('parseInbound', () => {
  const ok = { MessageSid: 'SM' + 'a'.repeat(32), From: '+15550111001', To: '+15550100001', Body: '  Plans please \u0007 ' };

  it('keeps the fields we need and strips control characters', () => {
    expect(parseInbound(ok)).toEqual({ messageSid: ok.MessageSid, from: ok.From, to: ok.To, body: 'Plans please' });
  });

  it("leaves Twilio's own keywords to Twilio (CANCEL would opt the owner out)", () => {
    for (const word of ['STOP', 'cancel', 'Cancel.', ' unsubscribe ', 'START', 'yes', 'HELP', 'quit']) {
      expect(parseInbound({ ...ok, Body: word })).toBeNull();
    }
    expect(parseInbound({ ...ok, Body: 'Plans please', OptOutType: 'STOP' })).toBeNull();
    expect(parseInbound({ ...ok, Body: 'Cancel the Mazali promotion idea' })).not.toBeNull();
  });

  it('refuses malformed ids, numbers, empty and oversized bodies', () => {
    expect(parseInbound({ ...ok, MessageSid: 'SM123' })).toBeNull();
    expect(parseInbound({ ...ok, From: '15550111001' })).toBeNull();
    expect(parseInbound({ ...ok, Body: '   ' })).toBeNull();
    expect(parseInbound({ ...ok, Body: 'x'.repeat(1601) })).toBeNull();
  });
});

describe('twiml', () => {
  it('escapes the message and allows an empty reply', () => {
    expect(twiml('a < b & "c"')).toContain('<Message>a &lt; b &amp; &quot;c&quot;</Message>');
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
