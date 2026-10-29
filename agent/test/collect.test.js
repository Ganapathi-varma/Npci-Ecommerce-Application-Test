import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, probe } from '../src/collect.js';
import { fakeKube, pod, deployment, container, NS } from './helpers.js';

const READ_ONLY_VERBS = new Set(['get', 'logs', 'auth']);

test('collection only ever issues read-only kubectl verbs', async () => {
  const kube = fakeKube(async (args) => {
    if (args[0] === 'get' && args[1] === 'namespace') return { stdout: 'namespace/x' };
    if (args[0] === 'get' && args[1] === 'pods') return { json: { items: [pod('c-1', 'ecommerce-customer', { containers: [container({ ready: false, restartCount: 2 })] })] } };
    if (args[0] === 'get' && args[1] === 'deployments') return { json: { items: [deployment('ecommerce-customer')] } };
    if (args[0] === 'auth') return { json: { status: { userInfo: { username: 'system:serviceaccount:npci-ecommerce:ai-agent' } } } };
    return { stdout: 'a log line' };
  });
  const b = await collect({ kube, namespace: NS });
  assert.ok(kube.calls.length > 5);
  for (const c of kube.calls) assert.ok(READ_ONLY_VERBS.has(c[0]), `non read-only call: ${c.join(' ')}`);
  assert.equal(b.identity, 'system:serviceaccount:npci-ecommerce:ai-agent');
  assert.ok(b.kube.logs['c-1'].previous !== undefined, 'restarted pod: previous logs requested');
  assert.ok(!kube.calls.some((c) => c.includes('secrets')), 'Secrets are never requested');
});

test('credentials in logs are redacted at collection time', async () => {
  const kube = fakeKube(async (args) => {
    if (args[0] === 'get' && args[1] === 'namespace') return { stdout: 'ok' };
    if (args[0] === 'get' && args[1] === 'pods') return { json: { items: [pod('c-1', 'd')] } };
    if (args[0] === 'logs') return { stdout: 'Authorization: Bearer abcdefghijklmnop12345\npassword=hunter2 token: eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4' };
    return { json: { items: [] } };
  });
  const b = await collect({ kube, namespace: NS });
  const text = JSON.stringify(b);
  for (const secret of ['abcdefghijklmnop12345', 'hunter2', 'SflKxwRJSMeKKF2QT4']) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test('a missing namespace is recorded as such and stops further lookups', async () => {
  const kube = fakeKube(async (args) => (args[1] === 'namespace' ? { ok: false, stderr: 'Error from server (NotFound): namespaces "npci-ecommerce" not found' } : { json: { items: [] } }));
  const b = await collect({ kube, namespace: NS });
  assert.equal(b.kube.namespaceExists, false);
  assert.ok(!kube.calls.some((c) => c.includes('deployments')));
});

test('forbidden reads become recorded errors, not crashes or guesses', async () => {
  const kube = fakeKube(async (args) => (args[1] === 'events' ? { ok: false, stderr: 'events is forbidden' } : args[1] === 'namespace' ? { stdout: 'ok' } : { json: { items: [] } }));
  const b = await collect({ kube, namespace: NS });
  assert.ok(b.kube.errors.some((e) => /events/.test(e.what) && /forbidden/.test(e.error)));
});

test('health probes classify success, HTTP errors and connection failures', async () => {
  assert.equal((await probe('http://x', async () => ({ status: 200 }))).ok, true);
  const bad = await probe('http://x', async () => ({ status: 503 }));
  assert.deepEqual([bad.ok, bad.status], [false, 503]);
  const refused = await probe('http://x', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } }); });
  assert.match(refused.error, /^ECONNREFUSED/);
});

test('CI status and trivy report are read from the files given', async () => {
  const files = { '/ci/ci-status.json': JSON.stringify({ job: 'j', build_number: 1, result: 'FAILURE', stages: { 'Vulnerability Scan': 'FAILURE' } }),
    '/ci/reports/trivy-report.json': JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: 'CRITICAL', VulnerabilityID: 'CVE-1', PkgName: 'libssl3', InstalledVersion: '1', FixedVersion: '2' }, { Severity: 'LOW', VulnerabilityID: 'CVE-2', PkgName: 'x' }] }] }) };
  const b = await collect({ ciStatusPath: '/ci/ci-status.json', readFile: (p) => { if (!files[p]) throw new Error('ENOENT'); return files[p]; } });
  assert.equal(b.ci.present, true);
  assert.deepEqual(b.ci.trivy.counts, { CRITICAL: 1, LOW: 1 });
  assert.equal(b.ci.trivy.fixable.length, 1);
});
