// Thin kubectl wrapper. Everything goes through execFile with an argv array - no shell, no string building.
import { run } from './util.js';

export function makeKube({ kubeconfig, namespace = 'npci-ecommerce', binary = 'kubectl' } = {}) {
  const base = [...(kubeconfig ? ['--kubeconfig', kubeconfig] : []), '--request-timeout=15s'];

  async function kubectl(args, opts) {
    return run(binary, [...base, ...args], opts);
  }

  async function getJson(args) {
    const r = await kubectl([...args, '-o', 'json']);
    if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() };
    try { return { ok: true, data: JSON.parse(r.stdout) }; }
    catch (e) { return { ok: false, error: `unparseable kubectl output: ${e.message}` }; }
  }

  return { kubectl, getJson, namespace, kubeconfig };
}
