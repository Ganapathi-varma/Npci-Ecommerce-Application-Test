// Command line interface:  node bin/ai-agent.js diagnose [options]
import fs from 'node:fs';
import { collect } from './collect.js';
import { analyze } from './analyze.js';
import { askClaude } from './llm.js';
import { renderText } from './report.js';
import { makeKube } from './kube.js';
import { makeAudit } from './audit.js';
import { reviewAction, terminalIo } from './approval.js';

const HELP = `AI incident agent for the e-commerce deployment

Usage: node bin/ai-agent.js diagnose [options]

Evidence sources
  --kubeconfig <file>    kubeconfig to use (use the ai-agent one: ~/.kube/ai-agent.kubeconfig)
  --namespace <name>     namespace to inspect (default npci-ecommerce)
  --ci-status <file>     ci-status.json archived by the Jenkins pipeline
  --trivy <file>         Trivy JSON report (default: reports/trivy-report.json next to ci-status.json)
  --url <url>            health-check URL to probe, e.g. http://$(minikube ip)/healthz (repeatable)
  --log-tail <n>         log lines per pod (default 60)
  --bundle <file>        analyse a previously saved evidence bundle instead of collecting (offline)
  --save-bundle <file>   save the (redacted) collected evidence for later / offline analysis

Output
  --llm                  add a Claude-written summary (needs ANTHROPIC_API_KEY or 'ant auth login'; AGENT_MODEL overrides the model)
  --json                 machine-readable output

Making changes (always asks first)
  --apply                walk through the proposed changes one at a time. Each needs you to type
                         "APPROVE <id>" in an interactive terminal. There is no auto-approve option.
  --audit-log <file>     where the audit trail is written (default ~/.ai-agent/audit.log)
`;

function parseArgs(argv) {
  const o = { urls: [], logTail: 60, namespace: 'npci-ecommerce' };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--kubeconfig': o.kubeconfig = need(i++); break;
      case '--namespace': o.namespace = need(i++); break;
      case '--ci-status': o.ciStatus = need(i++); break;
      case '--trivy': o.trivy = need(i++); break;
      case '--url': o.urls.push(need(i++)); break;
      case '--log-tail': o.logTail = Number(need(i++)); break;
      case '--bundle': o.bundle = need(i++); break;
      case '--save-bundle': o.saveBundle = need(i++); break;
      case '--audit-log': o.auditLog = need(i++); break;
      case '--llm': o.llm = true; break;
      case '--json': o.json = true; break;
      case '--apply': o.apply = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return o;
}

export async function main(argv, { io = terminalIo(), stdout = (s) => process.stdout.write(s) } = {}) {
  let opts; let command = argv[0];
  try { opts = parseArgs(argv.slice(1)); } catch (e) { stdout(`${e.message}\n\n${HELP}`); return 2; }
  if (!command || command === '-h' || command === '--help' || opts.help) { stdout(HELP); return 0; }
  if (command !== 'diagnose') { stdout(`unknown command: ${command}\n\n${HELP}`); return 2; }
  if (!Number.isInteger(opts.logTail) || opts.logTail < 1 || opts.logTail > 500) { stdout('--log-tail must be 1-500\n'); return 2; }

  const audit = makeAudit(opts.auditLog);
  const kube = makeKube({ kubeconfig: opts.kubeconfig, namespace: opts.namespace });

  let bundle;
  if (opts.bundle) bundle = JSON.parse(fs.readFileSync(opts.bundle, 'utf8'));
  else {
    bundle = await collect({ kube, namespace: opts.namespace, ciStatusPath: opts.ciStatus, trivyPath: opts.trivy, urls: opts.urls, logTail: opts.logTail });
    if (opts.saveBundle) fs.writeFileSync(opts.saveBundle, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  }

  const result = analyze(bundle);
  const llm = opts.llm ? await askClaude(result) : undefined;
  audit.record('diagnosis', { overall: result.overall, findings: result.findings.map((f) => `${f.id}:${f.status}:${f.title}`), proposedActions: result.actions.map((a) => a.id), llm: llm ? (llm.ok ? 'used' : 'failed') : 'off' });

  stdout(opts.json ? JSON.stringify({ result, llm }, null, 2) + '\n' : renderText(result, { llm }));

  // Warn when running with more power than the agent needs.
  if (/minikube-user|system:masters/.test(result.identity ?? '')) {
    stdout('WARNING: you are running the agent with ADMIN credentials. Use the restricted identity: --kubeconfig ~/.kube/ai-agent.kubeconfig\n');
  }

  if (opts.apply) {
    if (opts.bundle) { stdout('--apply cannot be combined with --bundle (offline data); changes are only offered against a live cluster.\n'); return 2; }
    if (result.actions.length === 0) { stdout('No changes proposed.\n'); return 0; }
    stdout(`Reviewing ${result.actions.length} proposed change(s). Audit trail: ${audit.file}\n`);
    for (const action of result.actions) await reviewAction(action, { kube, io, audit });
  }
  return result.overall === 'healthy' ? 0 : 1;
}
