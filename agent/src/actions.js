// The ONLY things the agent is able to do to the cluster. Each action:
//   - is built from validated parameters into an argv array (no shell, no free-form command text),
//   - carries the exact RBAC permission it needs (checked with `kubectl auth can-i` before asking you),
//   - has a server-side dry-run form, a risk rating and a rollback note.
// Neither a rule nor the language model can add to this list at runtime.
import { K8S_NAME } from './util.js';

function name(value, label) {
  if (typeof value !== 'string' || !K8S_NAME.test(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

export const ACTION_TYPES = {
  'rollout-restart': {
    risk: 'low',
    permission: { verb: 'patch', resource: 'deployments.apps' },
    check: (p) => ({ deployment: name(p.deployment, 'deployment') }),
    argv: (p, ns) => ['-n', ns, 'rollout', 'restart', `deployment/${p.deployment}`],
    dryRun: true,
    verifyRollout: (p) => p.deployment,
    describe: (p) => `Rolling restart of deployment ${p.deployment} (pods are replaced one at a time)`,
    rollback: () => 'Nothing to roll back: pods are recreated from the unchanged spec.',
  },
  'rollout-undo': {
    risk: 'medium',
    permission: { verb: 'patch', resource: 'deployments.apps' },
    check: (p) => ({ deployment: name(p.deployment, 'deployment') }),
    argv: (p, ns) => ['-n', ns, 'rollout', 'undo', `deployment/${p.deployment}`],
    dryRun: true,
    verifyRollout: (p) => p.deployment,
    describe: (p) => `Roll deployment ${p.deployment} back to its previous revision`,
    rollback: (p, ns) => `Run the same action again, or: kubectl -n ${ns} rollout undo deployment/${p.deployment}`,
  },
  scale: {
    risk: 'medium',
    permission: { verb: 'patch', resource: 'deployments.apps/scale' },
    check: (p) => {
      const raw = p.replicas;
      const numeric = typeof raw === 'number' || (typeof raw === 'string' && /^\d{1,2}$/.test(raw)); // null/''/[] must not become 0
      const replicas = numeric ? Number(raw) : NaN;
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10) throw new Error(`invalid replicas: ${JSON.stringify(p.replicas)} (0-10)`);
      return { deployment: name(p.deployment, 'deployment'), replicas };
    },
    argv: (p, ns) => ['-n', ns, 'scale', `deployment/${p.deployment}`, `--replicas=${p.replicas}`],
    dryRun: true,
    verifyRollout: (p) => (p.replicas > 0 ? p.deployment : null),
    describe: (p) => `Scale deployment ${p.deployment} to ${p.replicas} replica(s)`,
    rollback: (p, ns) => `kubectl -n ${ns} scale deployment/${p.deployment} --replicas=<previous count>`,
  },
  'delete-pod': {
    risk: 'low',
    permission: { verb: 'delete', resource: 'pods' },
    check: (p) => ({ pod: name(p.pod, 'pod') }),
    argv: (p, ns) => ['-n', ns, 'delete', 'pod', p.pod],
    dryRun: true,
    verifyRollout: () => null,
    describe: (p) => `Delete pod ${p.pod} so its controller recreates it`,
    rollback: () => 'Nothing to roll back: the Deployment immediately creates a replacement pod.',
  },
};

/** Validates parameters and returns a fully-specified, immutable action. Throws on anything unexpected. */
export function buildAction(type, params, namespace) {
  if (typeof type !== 'string' || !Object.hasOwn(ACTION_TYPES, type)) throw new Error(`unknown action type: ${JSON.stringify(type)}`); // own keys only: not __proto__ / constructor
  const def = ACTION_TYPES[type];
  const ns = name(namespace, 'namespace');
  const clean = def.check(params ?? {});
  const argv = def.argv(clean, ns);
  return Object.freeze({
    type,
    params: Object.freeze(clean),
    namespace: ns,
    mutating: true,
    risk: def.risk,
    permission: def.permission,
    description: def.describe(clean),
    rollback: def.rollback(clean, ns),
    argv,
    dryRunArgv: def.dryRun ? [...argv, '--dry-run=server'] : null,
    verifyDeployment: def.verifyRollout(clean),
    display: `kubectl ${argv.join(' ')}`,
  });
}
