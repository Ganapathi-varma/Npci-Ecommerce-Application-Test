import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAction } from '../src/actions.js';
import { reviewAction, approvalPhrase } from '../src/approval.js';
import { fakeKube, NS } from './helpers.js';

const action = (over = {}) => ({
  ...buildAction('rollout-undo', { deployment: 'ecommerce-customer' }, NS),
  id: 'A1', reason: 'previous revision was healthy', evidence: ['E1', 'E2'], findingId: 'F1', ...over,
});
const auditSink = () => { const events = []; return { events, file: 'mem', record: (event, data) => events.push({ event, ...data }) }; };
const ioWith = ({ interactive = true, answer = '' } = {}) => { const out = []; return { out, interactive, print: (s) => out.push(s), ask: async (q) => { out.push(q); return answer; } }; };
const kubeThat = ({ canI = 'yes' } = {}) => fakeKube(async (args) => {
  if (args[0] === 'auth') return { stdout: `${canI}\n` };
  if (args.includes('--dry-run=server')) return { stdout: 'deployment.apps/ecommerce-customer rolled back (server dry run)' };
  if (args.includes('rollout') && args.includes('status')) return { stdout: 'deployment "ecommerce-customer" successfully rolled out' };
  return { stdout: 'deployment.apps/ecommerce-customer rolled back' };
});
const executed = (kube, a) => kube.calls.some((c) => JSON.stringify(c) === JSON.stringify(a.argv));

test('typing the exact phrase for THIS action executes exactly the catalogued command', async () => {
  const kube = kubeThat(); const a = action(); const audit = auditSink();
  const r = await reviewAction(a, { kube, io: ioWith({ answer: approvalPhrase(a) }), audit });
  assert.equal(r.status, 'executed');
  assert.ok(executed(kube, a));
  assert.deepEqual(audit.events.map((e) => e.event), ['proposed', 'approved', 'executed', 'verified']);
});

test('the operator sees the evidence, command, risk, dry-run and rollback BEFORE being asked', async () => {
  const io = ioWith({ answer: 'no' });
  await reviewAction(action(), { kube: kubeThat(), io, audit: auditSink() });
  const shown = io.out.join('\n');
  for (const needle of ['E1, E2', 'kubectl -n npci-ecommerce rollout undo deployment/ecommerce-customer', 'MEDIUM', 'server dry run', 'Rollback']) assert.ok(shown.includes(needle), `missing: ${needle}`);
  assert.ok(shown.indexOf('Dry-run') < shown.indexOf('Type "APPROVE'));
});

for (const [label, answer] of [['empty answer', ''], ['y', 'y'], ['yes', 'yes'], ['lower-case phrase', 'approve a1'], ['another action id', 'APPROVE A2'], ['trailing junk', 'APPROVE A1 now']]) {
  test(`does NOT execute on "${label}"`, async () => {
    const kube = kubeThat(); const a = action(); const audit = auditSink();
    const r = await reviewAction(a, { kube, io: ioWith({ answer }), audit });
    assert.equal(r.status, 'rejected');
    assert.ok(!executed(kube, a));
    assert.ok(!audit.events.some((e) => e.event === 'approved'));
  });
}

test('without an interactive terminal nothing is executed, whatever would be typed', async () => {
  const kube = kubeThat(); const a = action(); const io = ioWith({ interactive: false, answer: approvalPhrase(a) });
  const r = await reviewAction(a, { kube, io, audit: auditSink() });
  assert.equal(r.status, 'approval-required');
  assert.ok(!executed(kube, a));
  assert.ok(!io.out.some((l) => l.includes('Type "APPROVE')), 'must not even prompt');
});

test('RBAC denial blocks the action before any dry-run or prompt', async () => {
  const kube = kubeThat({ canI: 'no' }); const a = action(); const io = ioWith({ answer: approvalPhrase(a) });
  const r = await reviewAction(a, { kube, io, audit: auditSink() });
  assert.equal(r.status, 'blocked');
  assert.ok(!executed(kube, a));
  assert.ok(!kube.calls.some((c) => c.includes('--dry-run=server')));
});

test('a failing command is reported as failed and is not verified', async () => {
  const kube = fakeKube(async (args) => (args[0] === 'auth' ? { stdout: 'yes' } : args.includes('--dry-run=server') ? { stdout: 'ok' } : { ok: false, stderr: 'boom' }));
  const a = action();
  const r = await reviewAction(a, { kube, io: ioWith({ answer: approvalPhrase(a) }), audit: auditSink() });
  assert.equal(r.status, 'failed');
  assert.ok(!kube.calls.some((c) => c.includes('status')));
});
