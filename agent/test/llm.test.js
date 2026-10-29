import test from 'node:test';
import assert from 'node:assert/strict';
import { askClaude, validateLlmOutput, buildUserMessage, OUTPUT_SCHEMA, DEFAULT_MODEL } from '../src/llm.js';
import { redact } from '../src/util.js';
import { analyze } from '../src/analyze.js';
import { emptyBundle } from './helpers.js';

const result = () => { const b = emptyBundle(); b.kube.namespaceExists = false; return analyze(b); };
const ids = (r) => ({ evidenceIds: new Set(r.evidence.map((e) => e.id)), actionIds: new Set(r.actions.map((a) => a.id)) });
const sdk = (create) => async () => ({ default: class { constructor() { this.beta = { messages: { create } }; } } });

test('invented evidence ids and action ids are removed and reported', () => {
  const r = result();
  const { value, dropped } = validateLlmOutput({
    summary: 's', root_cause: { statement: 'x', confidence: 'high', evidence_ids: ['E1', 'E99'], assumptions: [] },
    next_steps: [{ action_id: 'A1', rationale: 'r' }, { action_id: 'A42', rationale: 'r' }], unknowns: [],
  }, ids(r));
  assert.deepEqual(value.root_cause.evidence_ids, ['E1']);
  assert.deepEqual(value.next_steps, []);
  assert.ok(dropped.includes('unknown evidence id E99') && dropped.includes('unknown action id A1'));
});

test('high confidence without any valid citation is downgraded to low', () => {
  const { value } = validateLlmOutput({ summary: '', root_cause: { statement: 'x', confidence: 'high', evidence_ids: ['E77'], assumptions: [] }, next_steps: [], unknowns: [] }, ids(result()));
  assert.equal(value.root_cause.confidence, 'low');
});

test('the request is structured-output, redacted, and cannot contain secrets', () => {
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false);
  const b = emptyBundle(); b.kube.errors = [{ what: 'x', error: 'Authorization: Bearer abcdefghijklmnop12345 failed' }];
  const msg = buildUserMessage({ ...analyze(b) });
  assert.ok(!msg.includes('abcdefghijklmnop12345'));
});

test('a normal reply is parsed and validated; request uses the default model with server-side fallbacks', async () => {
  const r = result(); let seen;
  const reply = { summary: 'App not deployed.', root_cause: { statement: 'Namespace missing', confidence: 'high', evidence_ids: ['E1'], assumptions: [] }, next_steps: [], unknowns: [] };
  const out = await askClaude(r, { importSdk: sdk(async (req) => { seen = req; return { stop_reason: 'end_turn', model: req.model, content: [{ type: 'text', text: JSON.stringify(reply) }] }; }) });
  assert.equal(out.ok, true);
  assert.equal(seen.model, DEFAULT_MODEL);
  assert.equal(seen.fallbacks, 'default');
  assert.equal(seen.output_config.format.type, 'json_schema');
  assert.equal(seen.temperature, undefined, 'sampling parameters are not accepted on current models');
  assert.equal(out.value.root_cause.confidence, 'high');
});

test('refusal, truncation, missing SDK and API errors never throw and never block the rule-based report', async () => {
  const r = result();
  assert.match((await askClaude(r, { importSdk: sdk(async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })) })).error, /declined/);
  assert.match((await askClaude(r, { importSdk: sdk(async () => ({ stop_reason: 'max_tokens', content: [] })) })).error, /cut off/);
  assert.match((await askClaude(r, { importSdk: async () => { throw new Error('nope'); } })).error, /npm install/);
  const apiErr = Object.assign(new Error('invalid x-api-key sk-ant-abcdefghijklmnop'), { status: 401, name: 'AuthenticationError' });
  const out = await askClaude(r, { importSdk: sdk(async () => { throw apiErr; }) });
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('sk-ant-abcdefghijklmnop'), 'API keys must not be echoed');
});

test('redact() removes the credential shapes that appear in logs and error text', () => {
  const dirty = 'Bearer abcdefghijklmnopqrstuv, dckr_pat_AAAAAAAAAAAA, sk-ant-api03-ZZZZZZZZZZ, password: "p@ss", eyJabcdefgh.eyJabcdefgh.abcdefghijk';
  const clean = redact(dirty);
  for (const s of ['abcdefghijklmnopqrstuv', 'AAAAAAAAAAAA', 'ZZZZZZZZZZ', 'p@ss', 'eyJabcdefgh']) assert.ok(!clean.includes(s), s);
});
