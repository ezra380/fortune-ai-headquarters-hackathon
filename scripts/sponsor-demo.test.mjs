import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validateFindings } from './sponsor-demo.mjs';
test('rejects fabricated evidence and malformed findings', () => {
  for (const v of [{findings:[{summary:'x',evidenceIds:['invented']}]}, {findings:[{summary:'x',evidenceIds:[]}]}, {}])
    assert.throws(() => validateFindings(v, new Set(['demo-t001'])));
});
test('does not call network without key', async () => {
  await assert.rejects(analyze([], '', '', {}, () => { throw Error('network must not run'); }), /Set NEMOTRON_API_KEY/);
});
test('uses NVIDIA endpoint and validates returned evidence', async () => {
  const result = await analyze([{id:'demo-t001'}], '', '2026-10-26', {NEMOTRON_API_KEY:'test-only'}, async (url, req) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(req.redirect, 'error');
    assert.equal(JSON.parse(req.body).stream, false);
    return {status:200, json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({findings:[{summary:'Overdue',evidenceIds:['demo-t001']}]})}}]})};
  });
  assert.equal(result.findings[0].summary, 'Overdue');
});
test('provider errors do not expose response bodies or fall back', async () => {
  await assert.rejects(analyze([], '', '', {NEMOTRON_API_KEY:'test-only'}, async()=>({status:401, text:async()=>{throw Error('must not read');}})), /HTTP 401/);
});
test('truncated model output is rejected', async () => {
  await assert.rejects(analyze([], '', '', {NEMOTRON_API_KEY:'test-only'}, async()=>({status:200,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})})), /incomplete/);
});
