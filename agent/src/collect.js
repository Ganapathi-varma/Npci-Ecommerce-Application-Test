// Evidence collection. READ-ONLY: only `kubectl get/logs/auth` and plain HTTP GETs. Nothing here changes any system.
// Everything that cannot be observed is recorded in `errors` so the analysis can say "unknown" instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import { redact, tail } from './util.js';

const INGRESS_NS = 'ingress-nginx';

export async function collect({
  kube,
  namespace = kube?.namespace ?? 'npci-ecommerce',
  ciStatusPath,
  trivyPath,
  urls = [],
  logTail = 60,
  fetchImpl = globalThis.fetch,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  now = () => new Date(),
} = {}) {
  const bundle = {
    collectedAt: now().toISOString(),
    namespace,
    identity: null,
    ci: { present: false, reason: 'no --ci-status file given' },
    kube: {
      namespaceExists: null, deployments: [], replicaSets: [], pods: [], services: [], endpoints: [], ingresses: [],
      events: [], logs: {}, ingressController: { namespaceExists: null, pods: [], logs: '' }, errors: [],
    },
    health: [],
  };

  collectCi(bundle, { ciStatusPath, trivyPath, readFile });
  if (kube) await collectKube(bundle, { kube, namespace, logTail });
  for (const url of urls) bundle.health.push(await probe(url, fetchImpl));
  return bundle;
}

// ---------------------------------------------------------------- CI
function collectCi(bundle, { ciStatusPath, trivyPath, readFile }) {
  if (!ciStatusPath) return;
  try {
    bundle.ci = { present: true, status: JSON.parse(readFile(ciStatusPath)) };
  } catch (e) {
    bundle.ci = { present: false, reason: `cannot read ${ciStatusPath}: ${e.message}` };
    return;
  }
  const trivy = trivyPath ?? path.join(path.dirname(ciStatusPath), 'reports', 'trivy-report.json');
  try {
    const report = JSON.parse(readFile(trivy));
    const counts = {};
    const fixable = [];
    for (const result of report.Results ?? []) {
      for (const v of result.Vulnerabilities ?? []) {
        counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
        if (['HIGH', 'CRITICAL'].includes(v.Severity) && v.FixedVersion) {
          fixable.push({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion, severity: v.Severity });
        }
      }
    }
    bundle.ci.trivy = { file: trivy, counts, fixable };
  } catch { /* trivy report is optional */ }
}

// ---------------------------------------------------------------- Kubernetes
async function collectKube(bundle, { kube, namespace, logTail }) {
  const k = bundle.kube;
  const note = (what, error) => k.errors.push({ what, error: redact(error).slice(0, 300) });

  const who = await kube.getJson(['auth', 'whoami']);
  if (who.ok) bundle.identity = who.data?.status?.userInfo?.username ?? null;

  const ns = await kube.kubectl(['get', 'namespace', namespace, '-o', 'name']);
  if (ns.ok) k.namespaceExists = true;
  else if (/NotFound|not found/i.test(ns.stderr)) k.namespaceExists = false;
  else note(`get namespace ${namespace}`, ns.stderr || ns.stdout);
  if (k.namespaceExists === false) return;

  const list = async (key, resource, extra = []) => {
    const r = await kube.getJson(['get', resource, '-n', namespace, ...extra]);
    if (r.ok) k[key] = r.data.items ?? [];
    else note(`get ${resource}`, r.error);
  };
  await list('deployments', 'deployments');
  await list('replicaSets', 'replicasets');
  await list('pods', 'pods');
  await list('services', 'services');
  await list('endpoints', 'endpoints');
  await list('ingresses', 'ingresses');
  await list('events', 'events');

  // Logs: every pod that is unhealthy or has restarted, plus a few healthy ones (for HTTP status statistics).
  const wanted = k.pods
    .filter((p) => !isReady(p) || restarts(p) > 0)
    .concat(k.pods.filter((p) => isReady(p) && restarts(p) === 0).slice(0, 3))
    .slice(0, 8);
  for (const pod of wanted) {
    const name = pod.metadata.name;
    const current = await kube.kubectl(['logs', name, '-n', namespace, '--all-containers', `--tail=${logTail}`]);
    const entry = { current: current.ok ? redact(current.stdout) : '', previous: '' };
    if (restarts(pod) > 0) {
      const prev = await kube.kubectl(['logs', name, '-n', namespace, '--all-containers', '--previous', `--tail=${logTail}`]);
      if (prev.ok) entry.previous = redact(prev.stdout);
    }
    k.logs[name] = entry;
  }

  // Ingress controller (separate namespace; the agent only has read access there once the addon exists)
  const ing = await kube.kubectl(['get', 'namespace', INGRESS_NS, '-o', 'name']);
  if (ing.ok) {
    k.ingressController.namespaceExists = true;
    const pods = await kube.getJson(['get', 'pods', '-n', INGRESS_NS, '-l', 'app.kubernetes.io/component=controller']);
    if (pods.ok) {
      k.ingressController.pods = pods.data.items ?? [];
      const first = k.ingressController.pods[0]?.metadata?.name;
      if (first) {
        const logs = await kube.kubectl(['logs', first, '-n', INGRESS_NS, `--tail=${logTail * 2}`]);
        if (logs.ok) k.ingressController.logs = redact(logs.stdout);
      }
    } else note(`get pods -n ${INGRESS_NS}`, pods.error);
  } else if (/NotFound|not found/i.test(ing.stderr)) {
    k.ingressController.namespaceExists = false;
  } else {
    note(`get namespace ${INGRESS_NS}`, ing.stderr || ing.stdout);
  }
}

function restarts(pod) {
  return (pod.status?.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0);
}
function isReady(pod) {
  const cs = pod.status?.containerStatuses ?? [];
  return pod.status?.phase === 'Running' && cs.length > 0 && cs.every((c) => c.ready);
}

// ---------------------------------------------------------------- health checks
export async function probe(url, fetchImpl = globalThis.fetch, timeoutMs = 5000) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { url, ok: res.status >= 200 && res.status < 400, status: res.status, ms: Date.now() - started, error: null };
  } catch (e) {
    const code = e?.cause?.code ?? (e?.name === 'TimeoutError' ? 'ETIMEDOUT' : e?.code) ?? 'ERROR';
    return { url, ok: false, status: null, ms: Date.now() - started, error: `${code}: ${e?.cause?.message ?? e.message}` };
  }
}

export { tail };
