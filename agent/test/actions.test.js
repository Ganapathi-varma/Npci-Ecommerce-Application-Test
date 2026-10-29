import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAction, ACTION_TYPES } from '../src/actions.js';
import { NS } from './helpers.js';

test('the catalogue is exactly the four documented, bounded operations', () => {
  assert.deepEqual(Object.keys(ACTION_TYPES).sort(), ['delete-pod', 'rollout-restart', 'rollout-undo', 'scale']);
});

test('commands are argv arrays built from validated parts (no shell string anywhere)', () => {
  const a = buildAction('scale', { deployment: 'ecommerce-customer', replicas: 1 }, NS);
  assert.deepEqual(a.argv, ['-n', NS, 'scale', 'deployment/ecommerce-customer', '--replicas=1']);
  assert.deepEqual(a.dryRunArgv, [...a.argv, '--dry-run=server']);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.params));
});

for (const bad of ['x; rm -rf /', 'a b', '$(id)', 'UPPER', '../etc', '', 'a\nb', 'a|b', '-n=kube-system', undefined, 42]) {
  test(`rejects hostile deployment name ${JSON.stringify(bad)}`, () => {
    assert.throws(() => buildAction('rollout-restart', { deployment: bad }, NS), /invalid deployment/);
  });
}

test('rejects hostile namespace, bad replica counts and unknown action types', () => {
  assert.throws(() => buildAction('rollout-restart', { deployment: 'x' }, 'kube-system; id'), /invalid namespace/);
  for (const n of [-1, 11, 1.5, 'abc', null, '', [], {}, true, undefined, NaN]) assert.throws(() => buildAction('scale', { deployment: 'x', replicas: n }, NS), /invalid replicas/);
  for (const t of ['exec', 'delete-deployment', 'apply', 'patch', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 5]) assert.throws(() => buildAction(t, {}, NS), /unknown action type/);
});

test('every action names the RBAC permission it needs and a rollback', () => {
  for (const [type, params] of [['rollout-restart', { deployment: 'd' }], ['rollout-undo', { deployment: 'd' }], ['scale', { deployment: 'd', replicas: 2 }], ['delete-pod', { pod: 'p' }]]) {
    const a = buildAction(type, params, NS);
    assert.ok(a.permission.verb && a.permission.resource && a.rollback && ['low', 'medium', 'high'].includes(a.risk));
  }
});
