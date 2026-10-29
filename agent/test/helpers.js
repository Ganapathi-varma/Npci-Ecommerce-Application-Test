// Builders for Kubernetes-shaped fixtures (only the fields the agent reads).
export const NS = 'npci-ecommerce';

export function emptyBundle(over = {}) {
  return {
    collectedAt: '2026-10-29T12:00:00.000Z', namespace: NS, identity: 'system:serviceaccount:npci-ecommerce:ai-agent',
    ci: { present: false, reason: 'test' },
    kube: {
      namespaceExists: true, deployments: [], replicaSets: [], pods: [], services: [], endpoints: [], ingresses: [], events: [],
      logs: {}, ingressController: { namespaceExists: false, pods: [], logs: '' }, errors: [],
    },
    health: [],
    ...over,
  };
}

export const deployment = (name, { replicas = 2, available = replicas, conditions = [] } = {}) => ({
  metadata: { name },
  spec: { replicas, template: { metadata: { labels: { app: name } } } },
  status: { availableReplicas: available, conditions },
});

export const replicaSet = (dep, { replicas = 0, hash = 'old1234567' } = {}) => ({
  metadata: { name: `${dep}-${hash}`, ownerReferences: [{ kind: 'Deployment', name: dep }] },
  spec: { replicas }, status: { observedGeneration: 1 },
});

export const container = ({ name = 'frontend', image = 'npci-ecommerce-frontend:9-abc', ready = true, restartCount = 0, waiting, terminated, lastTerminated } = {}) => ({
  name, image, ready, restartCount,
  state: waiting ? { waiting } : terminated ? { terminated } : { running: {} },
  lastState: lastTerminated ? { terminated: lastTerminated } : {},
});

export const pod = (name, dep, { phase = 'Running', containers = [container()], limits, readOnlyFs } = {}) => ({
  metadata: { name, ownerReferences: [{ kind: 'ReplicaSet', name: `${dep}-new7654321` }] },
  spec: { containers: [{ name: 'frontend', resources: { limits }, securityContext: { readOnlyRootFilesystem: readOnlyFs } }] },
  status: { phase, containerStatuses: containers },
});

export const event = (podName, reason, message, type = 'Warning') => ({
  type, reason, message, involvedObject: { kind: 'Pod', name: podName },
});

export const service = (name, selector) => ({ metadata: { name }, spec: { selector, type: 'ClusterIP' } });
export const endpoints = (name, readyAddresses) => ({ metadata: { name }, subsets: readyAddresses ? [{ addresses: Array.from({ length: readyAddresses }, (_, i) => ({ ip: `10.0.0.${i}` })) }] : [] });

/** Minimal fake of makeKube(): records every call and answers from a handler. */
export function fakeKube(handler) {
  const calls = [];
  return {
    calls, namespace: NS,
    async kubectl(args, opts) {
      calls.push(args);
      const r = (await handler(args, opts)) ?? {};
      return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    async getJson(args) {
      calls.push([...args, '-o', 'json']);
      const r = (await handler(args)) ?? {};
      return r.ok === false ? { ok: false, error: r.stderr ?? 'error' } : { ok: true, data: r.json ?? { items: [] } };
    },
  };
}
