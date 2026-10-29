import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parseAccessLine } from '../src/analyze.js';
import { emptyBundle, deployment, replicaSet, pod, container, event, service, endpoints } from './helpers.js';

const find = (r, text) => r.findings.find((f) => f.title.includes(text));

/** Invariants that must hold for EVERY diagnosis, whatever the scenario. */
function assertTrustworthy(r) {
  const ids = new Set(r.evidence.map((e) => e.id));
  for (const f of r.findings) {
    for (const id of f.evidence) assert.ok(ids.has(id), `${f.id} cites unknown evidence ${id}`);
    if (f.status === 'confirmed') assert.equal(f.assumptions.length, 0, `${f.id} is "confirmed" but lists assumptions`);
    if (f.status === 'likely') assert.ok(f.assumptions.length > 0, `${f.id} is "likely" without stating assumptions`);
    for (const a of f.actions) assert.ok(r.actions.some((x) => x.id === a));
  }
  for (const a of r.actions) assert.ok(a.mutating && a.argv.every((p) => typeof p === 'string'));
}

const withPods = (pods, extra = {}) => {
  const b = emptyBundle();
  Object.assign(b.kube, { deployments: [deployment('ecommerce-customer', { available: 0 })], pods }, extra);
  return b;
};

test('image never pulled: confirmed from the event, no assumption needed', () => {
  const p = pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ErrImageNeverPull' } })] });
  const r = analyze(withPods([p], { events: [event('c-1', 'ErrImageNeverPull', 'Container image "npci-ecommerce-frontend:9-abc" is not present with pull policy of Never')] }));
  const f = find(r, 'Image cannot be pulled');
  assert.equal(f.status, 'confirmed');
  assert.equal(f.severity, 'critical');
  assert.match(f.conclusion, /not present on the node/);
  assert.match(f.manual.join(' '), /minikube image load/);
  assert.equal(r.actions.length, 0, 'no previous revision exists, so no rollback may be offered');
  assertTrustworthy(r);
});

test('image pull error without an explanatory event is only "likely" and states the assumption', () => {
  const p = pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ImagePullBackOff' } })] });
  const r = analyze(withPods([p]));
  const f = find(r, 'Image cannot be pulled');
  assert.equal(f.status, 'likely');
  assert.match(f.assumptions[0], /never loaded into Minikube/);
  assertTrustworthy(r);
});

test('image problem with an older revision available proposes a rollback (needs approval)', () => {
  const p = pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ImagePullBackOff' } })] });
  const r = analyze(withPods([p], { replicaSets: [replicaSet('ecommerce-customer', { replicas: 0 }), replicaSet('ecommerce-customer', { replicas: 2, hash: 'new7654321' })] }));
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'rollout-undo');
  assert.deepEqual(r.actions[0].argv, ['-n', 'npci-ecommerce', 'rollout', 'undo', 'deployment/ecommerce-customer']);
  assertTrustworthy(r);
});

test('OOMKilled crash loop: cause is stated from the termination record and the spec limit', () => {
  const c = container({ ready: false, restartCount: 5, waiting: { reason: 'CrashLoopBackOff' }, lastTerminated: { reason: 'OOMKilled', exitCode: 137 } });
  const r = analyze(withPods([pod('c-1', 'ecommerce-customer', { containers: [c], limits: { memory: '128Mi' } })]));
  const f = find(r, 'crash loop');
  assert.equal(f.status, 'confirmed');
  assert.match(f.conclusion, /memory limit \(128Mi\)/);
  assertTrustworthy(r);
});

test('nginx [emerg] in the previous log is quoted as evidence', () => {
  const c = container({ ready: false, restartCount: 3, waiting: { reason: 'CrashLoopBackOff' }, lastTerminated: { reason: 'Error', exitCode: 1 } });
  const b = withPods([pod('c-1', 'ecommerce-customer', { containers: [c] })]);
  b.kube.logs['c-1'] = { current: '', previous: '2026/10/29 [emerg] 1#1: unknown directive "foo" in /etc/nginx/conf.d/default.conf:3' };
  const r = analyze(b);
  const f = find(r, 'crash loop');
  assert.match(f.conclusion, /configuration error/);
  assert.ok(r.evidence.some((e) => /unknown directive/.test(e.fact)));
  assertTrustworthy(r);
});

test('crash loop with no useful log does NOT invent a cause', () => {
  const c = container({ ready: false, restartCount: 4, waiting: { reason: 'CrashLoopBackOff' }, lastTerminated: { reason: 'Error', exitCode: 1 } });
  const r = analyze(withPods([pod('c-1', 'ecommerce-customer', { containers: [c] })]));
  const f = find(r, 'crash loop');
  assert.equal(f.status, 'likely');
  assert.match(f.conclusion, /do not show why/);
  assert.ok(f.assumptions.length > 0);
  assertTrustworthy(r);
});

test('missing Secret is detected from the mount event, with a manual fix only (the agent cannot read or create Secrets)', () => {
  const p = pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ContainerCreating' } })] });
  const r = analyze(withPods([p], { events: [event('c-1', 'FailedMount', 'MountVolume.SetUp failed for volume "app-config" : secret "ecommerce-frontend-secret" not found')] }));
  const f = find(r, 'is missing');
  assert.equal(f.severity, 'critical');
  assert.equal(f.status, 'confirmed');
  assert.match(f.title, /ecommerce-frontend-secret/);
  assert.equal(r.actions.length, 0);
  assert.match(f.manual[0], /deploy\.sh/);
  assertTrustworthy(r);
});

test('REGRESSION: a stale FailedMount event is ignored once the pod has moved past container creation', () => {
  const p = pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ImagePullBackOff' } })] });
  const r = analyze(withPods([p], { events: [event('c-1', 'FailedMount', 'MountVolume.SetUp failed for volume "app-config" : secret "ecommerce-frontend-secret" not found')] }));
  assert.equal(find(r, 'is missing'), undefined, 'the Secret was mounted since; reporting it missing would be a false claim');
  assert.ok(find(r, 'Image cannot be pulled'));
  const gone = analyze(withPods([], { events: [event('deleted-pod', 'FailedMount', 'secret "x" not found')] }));
  assert.equal(find(gone, 'is missing'), undefined, 'events about pods that no longer exist are history');
});

test('Pending pod with insufficient CPU proposes scaling down by one', () => {
  const p = pod('c-2', 'ecommerce-customer', { phase: 'Pending', containers: [] });
  const r = analyze(withPods([p], { events: [event('c-2', 'FailedScheduling', '0/1 nodes are available: 1 Insufficient cpu.')] }));
  assert.equal(find(r, 'cannot be scheduled').status, 'confirmed');
  assert.deepEqual(r.actions.map((a) => [a.type, a.params.replicas]), [['scale', 1]]);
  assertTrustworthy(r);
});

test('missing namespace: one clear finding, overall DOWN', () => {
  const b = emptyBundle(); b.kube.namespaceExists = false;
  const r = analyze(b);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, 'Application is not deployed');
  assert.equal(r.overall, 'down');
  assertTrustworthy(r);
});

test('healthy system: no runtime findings, healthy status, positive evidence recorded', () => {
  const b = emptyBundle();
  b.kube.deployments = [deployment('ecommerce-customer'), deployment('ecommerce-seller', { replicas: 1 })];
  b.kube.pods = [pod('c-1', 'ecommerce-customer'), pod('c-2', 'ecommerce-customer')];
  b.kube.services = [service('ecommerce-customer', { app: 'ecommerce-customer' })];
  b.kube.endpoints = [endpoints('ecommerce-customer', 2)];
  b.health = [{ url: 'http://x/healthz', ok: true, status: 200, ms: 12, error: null }];
  const r = analyze(b);
  assert.deepEqual(r.findings, []);
  assert.equal(r.overall, 'healthy');
  assert.ok(r.evidence.some((e) => /Fully available/.test(e.fact)));
  assertTrustworthy(r);
});

test('ingress without controller explains an unreachable health URL, flagged as an assumption-based link', () => {
  const b = emptyBundle();
  b.kube.deployments = [deployment('ecommerce-customer')];
  b.kube.ingresses = [{ metadata: { name: 'ecommerce-web' } }];
  b.health = [{ url: 'http://192.168.49.2/healthz', ok: false, status: null, ms: 40, error: 'ECONNREFUSED: connect ECONNREFUSED' }];
  const r = analyze(b);
  assert.equal(find(r, 'No ingress controller').status, 'confirmed');
  const h = find(r, 'Health check failing');
  assert.equal(h.status, 'likely');
  assert.match(h.assumptions[0], /routed through the Ingress/);
  assertTrustworthy(r);
});

test('failed CI vulnerability scan is summarised from ci-status.json + the trivy report', () => {
  const b = emptyBundle();
  b.kube = null;
  b.ci = {
    present: true,
    status: { job: 'E-commerce-CI', build_number: 6, result: 'FAILURE', commit: 'abc1234', image: 'npci:6', stages: { Checkout: 'SUCCESS', 'Vulnerability Scan': 'FAILURE' } },
    trivy: { file: 'reports/trivy-report.json', counts: { HIGH: 55, CRITICAL: 3 }, fixable: [{ pkg: 'libcrypto3' }, { pkg: 'curl' }, { pkg: 'libcrypto3' }] },
  };
  const r = analyze(b);
  const f = find(r, 'CI failure: Vulnerability Scan');
  assert.equal(f.status, 'confirmed');
  assert.match(f.conclusion, /3 fixable HIGH\/CRITICAL/);
  assert.equal(f.area, 'ci');
  assert.equal(r.overall, 'ci-failed');
  assert.ok(r.unknowns.some((u) => /console output/.test(u)), 'must admit the CI root cause is not in the data');
  assertTrustworthy(r);
});

test('5xx on /api in the ingress log is reported with the backend cause marked as an assumption', () => {
  const b = emptyBundle();
  b.kube.deployments = [deployment('ecommerce-customer')];
  b.kube.ingressController = { namespaceExists: true, pods: [{ metadata: { name: 'ic' }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } }], logs: [
    '10.0.0.1 - - [29/Oct/2026] "GET /api/products HTTP/1.1" 502 150 "-" "curl"',
    '10.0.0.1 - - [29/Oct/2026] "GET /api/products HTTP/1.1" 502 150 "-" "curl"',
    '10.0.0.1 - - [29/Oct/2026] "GET / HTTP/1.1" 200 800 "-" "curl"'].join('\n') };
  b.kube.ingresses = [{ metadata: { name: 'ecommerce-api' } }];
  const r = analyze(b);
  const f = find(r, '5xx');
  assert.equal(f.status, 'likely');
  assert.match(f.assumptions[0], /Render/);
  assert.ok(r.evidence.some((e) => /2 of 3 logged requests/.test(e.fact)));
  assertTrustworthy(r);
});

test('things the agent could not read are reported as unknown, not guessed', () => {
  const b = emptyBundle();
  b.kube.errors = [{ what: 'get events', error: 'events is forbidden' }];
  const r = analyze(b);
  assert.ok(r.unknowns.some((u) => /get events.*forbidden/.test(u)));
});

test('access log parsing handles the JSON format from nginx.conf and the combined format', () => {
  assert.deepEqual(parseAccessLine('{"status":502,"uri":"/api/x?a=1"}'), { status: 502, path: '/api/x?a=1' });
  assert.deepEqual(parseAccessLine('1.2.3.4 - - [d] "POST /api/auth/login HTTP/1.1" 504 0'), { status: 504, path: '/api/auth/login' });
  assert.equal(parseAccessLine('not a log line'), null);
});
