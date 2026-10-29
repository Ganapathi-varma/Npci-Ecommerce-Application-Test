import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { emptyBundle, deployment, pod, container, event } from './helpers.js';

const run = async (args) => { let out = ''; const code = await main(args, { io: { interactive: false, print: () => {}, ask: async () => '' }, stdout: (s) => { out += s; } }); return { code, out }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));

test('offline diagnosis from a saved bundle prints findings, evidence, assumptions and the plan', async () => {
  const dir = tmp(); const f = path.join(dir, 'b.json');
  const b = emptyBundle();
  b.kube.deployments = [deployment('ecommerce-customer', { available: 0 })];
  b.kube.pods = [pod('c-1', 'ecommerce-customer', { phase: 'Pending', containers: [container({ ready: false, waiting: { reason: 'ErrImageNeverPull' } })] })];
  b.kube.events = [event('c-1', 'ErrImageNeverPull', 'Container image "x" is not present with pull policy of Never')];
  fs.writeFileSync(f, JSON.stringify(b));
  const { code, out } = await run(['diagnose', '--bundle', f, '--audit-log', path.join(dir, 'audit.log')]);
  assert.equal(code, 1);
  for (const needle of ['FINDINGS', 'CONFIRMED', 'EVIDENCE (directly observed facts)', 'Assumption : none needed', 'RECOMMENDED PLAN', 'minikube image load']) assert.ok(out.includes(needle), needle);
  assert.ok(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').includes('"event":"diagnosis"'));
});

test('--apply is refused on offline data and unknown flags are rejected', async () => {
  const dir = tmp(); const f = path.join(dir, 'b.json'); fs.writeFileSync(f, JSON.stringify(emptyBundle()));
  assert.equal((await run(['diagnose', '--bundle', f, '--apply', '--audit-log', path.join(dir, 'a.log')])).code, 2);
  assert.equal((await run(['diagnose', '--yes'])).code, 2);
  assert.equal((await run(['diagnose', '--auto-approve'])).code, 2);
  assert.equal((await run(['frobnicate'])).code, 2);
});

test('there is no auto-approve switch anywhere in the CLI help', async () => {
  const { out } = await run(['--help']);
  assert.ok(!/--yes|auto-approve|--force|--no-confirm/i.test(out.replace('There is no auto-approve option.', '')));
});
