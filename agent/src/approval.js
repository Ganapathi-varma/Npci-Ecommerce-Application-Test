// Human-in-the-loop gate. No code path executes a change without it, and there is deliberately no
// "--yes" / auto-approve option anywhere in the agent.
import readline from 'node:readline';

/** I/O used for the prompts. Tests inject their own; the CLI uses the terminal. */
export function terminalIo() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    print: (text) => process.stdout.write(`${text}\n`),
    ask: (question) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer); });
      }),
  };
}

export const approvalPhrase = (action) => `APPROVE ${action.id}`;

/**
 * Shows one proposed change and executes it only if the operator types the exact phrase.
 * Returns { status: 'executed' | 'failed' | 'rejected' | 'blocked' | 'approval-required', ... }
 */
export async function reviewAction(action, { kube, io, audit }) {
  audit.record('proposed', { id: action.id, type: action.type, command: action.display, findingId: action.findingId });
  const header = `\n--- Proposed change ${action.id}: ${action.description} ---`;

  // 1. RBAC pre-check: don't offer something the agent's identity cannot do anyway.
  const { verb, resource } = action.permission;
  const can = await kube.kubectl(['auth', 'can-i', verb, resource, '-n', action.namespace]);
  if (can.stdout.trim() !== 'yes') {
    io.print(`${header}\n  BLOCKED by RBAC: this identity may not "${verb} ${resource}" in ${action.namespace}. Nothing was run.`);
    audit.record('blocked', { id: action.id, reason: 'rbac' });
    return { status: 'blocked', reason: 'rbac' };
  }

  // 2. Server-side dry-run so you see what Kubernetes itself would do.
  let dryRun = 'not available for this action';
  if (action.dryRunArgv) {
    const r = await kube.kubectl(action.dryRunArgv);
    dryRun = (r.stdout || r.stderr).trim() || '(no output)';
  }

  io.print([
    header,
    `  Why        : ${action.reason}`,
    `  Evidence   : ${action.evidence.join(', ') || '(none cited)'}`,
    `  Command    : ${action.display}`,
    `  Risk       : ${action.risk.toUpperCase()}   (modifies the live cluster)`,
    `  Dry-run    : ${dryRun}`,
    `  Rollback   : ${action.rollback}`,
  ].join('\n'));

  // 3. No terminal -> never execute.
  if (!io.interactive) {
    io.print('  Not executed: approval needs an interactive terminal (this agent has no auto-approve mode).');
    audit.record('approval-required', { id: action.id });
    return { status: 'approval-required' };
  }

  // 4. Exact phrase, tied to this action's id, so a stray "y" or Enter can never approve anything.
  const phrase = approvalPhrase(action);
  const answer = (await io.ask(`  Type "${phrase}" to run it, anything else to skip: `)).trim();
  if (answer !== phrase) {
    io.print('  Skipped. Nothing was changed.');
    audit.record('rejected', { id: action.id, answer: answer.slice(0, 40) });
    return { status: 'rejected' };
  }

  audit.record('approved', { id: action.id, command: action.display });
  const result = await kube.kubectl(action.argv, { timeoutMs: 60000 });
  const output = (result.stdout || result.stderr).trim();
  io.print(`  ${result.ok ? 'Executed' : 'FAILED'}: ${output}`);
  audit.record(result.ok ? 'executed' : 'failed', { id: action.id, output: output.slice(0, 500) });
  if (!result.ok) return { status: 'failed', output };

  // 5. Read-only follow-up: did it work?
  if (action.verifyDeployment) {
    const v = await kube.kubectl(['-n', action.namespace, 'rollout', 'status', `deployment/${action.verifyDeployment}`, '--timeout=90s'], { timeoutMs: 100000 });
    const verdict = (v.stdout || v.stderr).trim().split('\n').pop();
    io.print(`  Verification: ${verdict}`);
    audit.record('verified', { id: action.id, ok: v.ok, verdict });
    return { status: 'executed', output, verified: v.ok, verdict };
  }
  return { status: 'executed', output };
}
