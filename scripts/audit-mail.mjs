// Read-only mail-flow audit. Every HTTP request is intercepted locally.
// Run: node --import ./server/node_modules/tsx/dist/loader.mjs scripts/audit-mail.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { notifyIfChanged } from '../server/src/sfre/report/service.js';

process.env.RESEND_API_KEY = 're_LOCAL_AUDIT_NOT_A_REAL_KEY';
process.env.CENTER_EMAIL = 'bqi@boldas.com.tr';
delete process.env.SFRE_ALERT_EMAILS;
const calls = [];
let mode = 'success';
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, 'api.resend.com');
  calls.push(JSON.parse(options.body));
  if (mode === 'network') throw new Error('LOCAL_AUDIT_NETWORK_FAILURE');
  const status = mode === 'success' ? 200 : Number(mode);
  return new Response(JSON.stringify(status === 200
    ? { id: `audit-${calls.length}` }
    : { name: status === 429 ? 'rate_limit_exceeded' : status >= 500 ? 'internal_server_error' : 'validation_error', message: `LOCAL_AUDIT_${status}` }),
  { status, headers: { 'content-type': 'application/json' } });
};
const mail = await import('../server/src/services/email.js');
const recipients = [{ email: 'first@example.invalid', nickname: '<script>first</script>' }, { email: 'second@example.invalid', nickname: 'second' }];
const buffer = Buffer.from('LOCAL AUDIT ATTACHMENT — Türkçe');
const scenarios = [
  ['approval', () => mail.sendApprovalEmail('<script>audit</script>', 'https://example.invalid/approve', 'https://example.invalid/reject'), 1],
  ['analysis-report', () => mail.sendAnalysisReport('<script>audit</script>', 'ekonomi', '<script>title</script>', buffer), 1],
  ['emergency-center', () => mail.sendEmergencyAlert('<script>audit</script>', '<script>message</script>', '<script>region</script>'), 1],
  ['emergency-users', () => mail.sendEmergencyBroadcastEmail('<script>audit</script>', '<script>message</script>', recipients), 2],
  ['direct-message', () => mail.sendDirectMessageEmail('first@example.invalid', '<script>name</script>', '<script>from</script>', '<script>message</script>'), 1],
  ['meeting-users', () => mail.sendVideoMeetingStartedToUsers('<script>audit</script>', recipients), 2],
  ['meeting-center', () => mail.sendVideoMeetingStartedAlert('<script>audit</script>'), 1],
  ['bfi-report', () => mail.sendSfreReportEmail({ subject: 'LOCAL AUDIT BFI', text: 'LOCAL AUDIT', html: '<p>LOCAL AUDIT</p>', attachments: [{ filename: 'audit.html', content: buffer }] }), 1],
];
const results = { runAt: new Date().toISOString(), liveEmailsSent: 0, transport: 'local mock only', templates: [], errorHandling: [] };
for (const [name, run, expected] of scenarios) {
  mode = 'success'; calls.length = 0;
  await run();
  assert.equal(calls.length, expected);
  for (const payload of calls) {
    assert.equal(payload.from, 'BQI <bqi@boldas.com.tr>');
    assert.ok(payload.to);
    assert.ok(payload.subject);
    assert.ok(!payload.html.includes('<script>'));
    assert.ok(!payload.cc && !payload.bcc);
  }
  if (name === 'analysis-report' || name === 'bfi-report') {
    assert.deepEqual(Buffer.from(calls[0].attachments[0].content, 'base64'), buffer);
  }
  if (['approval', 'analysis-report', 'emergency-center', 'meeting-center', 'bfi-report'].includes(name)) {
    assert.deepEqual([calls[0].to].flat(), ['bqi@boldas.com.tr']);
  }
  if (expected === 2) {
    assert.deepEqual(calls.map(x => [x.to].flat()), [['first@example.invalid'], ['second@example.invalid']]);
  }
  results.templates.push({ name, result: 'PASS', messageCount: calls.length, htmlEscaping: 'PASS', ...(name.includes('report') ? { attachmentBytes: 'PASS' } : {}) });
}
process.env.SFRE_ALERT_EMAILS = ' info@boldas.com.tr , bqi@boldas.com.tr ';
calls.length = 0;
await scenarios[7][1]();
assert.deepEqual(calls[0].to, ['info@boldas.com.tr', 'bqi@boldas.com.tr']);
results.bfiRecipientOverride = 'PASS';
delete process.env.SFRE_ALERT_EMAILS;
for (const failure of ['403', '429', '500', 'network']) {
  mode = failure;
  for (const [name, run] of scenarios) {
    calls.length = 0;
    try {
      const result = await run();
      const rejected = Array.isArray(result)
        ? result.filter(x => x.status === 'rejected').length
        : 0;
      results.errorHandling.push({ name, failure, promise: 'resolved', errorReturned: !!result?.error, rejectedRecipients: rejected, attempts: calls.length });
    } catch (error) {
      results.errorHandling.push({ name, failure, promise: 'rejected', attempts: calls.length });
    }
  }
}
mode = '403';
const state = [];
const db = { async list() { return []; }, async append(collection, record) { state.push({ collection, record }); return record; } };
try {
  await notifyIfChanged({ db, pg: async () => ({ rows: [] }), registry: { list: () => [] }, force: true, send: mail.sendSfreReportEmail });
  assert.fail('Rejected BFI submission must throw');
} catch (error) { results.bfiFailedDelivery = { rejected: true, alertStateWritten: state.some(x => x.collection === 'alert_state'), simulatedProviderStatus: 403 }; }
assert.equal(results.bfiFailedDelivery.alertStateWritten, false);
for (const result of results.errorHandling) assert.equal(result.promise, 'rejected');
delete process.env.RESEND_API_KEY;
const disabled = await import('../server/src/services/email.js?audit-disabled');
await assert.rejects(disabled.sendSfreReportEmail({ subject: 'LOCAL AUDIT', text: 'LOCAL AUDIT' }));
results.missingApiKey = { rejected: true };
await writeFile(new URL('../MAIL_AUDIT_RESULTS.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ templatesPassed: results.templates.length, errorsExercised: results.errorHandling.length, bfiFailedDelivery: results.bfiFailedDelivery, liveEmailsSent: 0 }, null, 2));
