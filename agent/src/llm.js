// Optional narrative layer (--llm). The rule engine in analyze.js remains the source of truth; Claude only
//   * summarises the evidence in plain language and picks the most likely root cause among the findings, and
//   * orders the already-proposed actions.
// It cannot add evidence, commands or actions: its answer is validated against the real evidence/action ids and
// anything it invents is dropped and reported. Everything sent to the API is redacted first, and no Secret or
// raw kubeconfig is ever collected in the first place.
import { redact } from './util.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    root_cause: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        evidence_ids: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
      },
      required: ['statement', 'confidence', 'evidence_ids', 'assumptions'],
      additionalProperties: false,
    },
    next_steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { action_id: { type: 'string' }, rationale: { type: 'string' } },
        required: ['action_id', 'rationale'],
        additionalProperties: false,
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'root_cause', 'next_steps', 'unknowns'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are an SRE assistant helping an operator investigate a failing deployment of a small e-commerce web application (Angular frontend served by nginx on Kubernetes/Minikube, built by a Jenkins pipeline).

You receive a JSON document produced by a deterministic analyzer: numbered evidence items (E1, E2, ...), findings that cite them, proposed actions (A1, A2, ...), and a list of things that could not be observed.

Rules:
1. Use ONLY the supplied evidence. Never invent log lines, versions, causes or facts that are not in the document.
2. Keep observed facts and assumptions strictly apart. Put every claim that is not directly backed by an evidence item in "assumptions" and lower the confidence accordingly. Use "high" only when the evidence directly proves the root cause and no assumption is needed.
3. Cite evidence ids that exist in the document. Do not cite ids that are not present.
4. "next_steps" may only reference action ids from the supplied "actions" list, in the order you recommend. Do not write shell commands. Actions that modify the cluster will be shown to a human who must approve each one; say why each is worth approving.
5. If the evidence is insufficient to name a root cause, say so, give "low" confidence and list what is missing under "unknowns".
6. Be concise: a summary of at most 3 sentences.`;

/** Builds the (already redacted) user message from an analysis result. */
export function buildUserMessage(result) {
  const doc = {
    overall_status: result.overall,
    namespace: result.namespace,
    findings: result.findings.map((f) => ({
      id: f.id, title: f.title, severity: f.severity, status: f.status, conclusion: f.conclusion,
      evidence_ids: f.evidence, assumptions: f.assumptions, action_ids: f.actions,
      manual_steps: f.manual,
    })),
    evidence: result.evidence,
    actions: result.actions.map((a) => ({ id: a.id, description: a.description, risk: a.risk, reason: a.reason, modifies_cluster: true })),
    could_not_observe: result.unknowns,
  };
  return redact(JSON.stringify(doc, null, 2));
}

/** Drops anything the model referenced that does not exist, and downgrades confidence it cannot justify. */
export function validateLlmOutput(raw, { evidenceIds, actionIds }) {
  const dropped = [];
  const rc = raw?.root_cause ?? {};
  const cited = (rc.evidence_ids ?? []).filter((id) => {
    if (evidenceIds.has(id)) return true;
    dropped.push(`unknown evidence id ${id}`);
    return false;
  });
  let confidence = ['high', 'medium', 'low'].includes(rc.confidence) ? rc.confidence : 'low';
  if (cited.length === 0 && confidence !== 'low') {
    dropped.push('confidence lowered: no valid evidence cited');
    confidence = 'low';
  }
  const steps = (raw?.next_steps ?? []).filter((s) => {
    if (actionIds.has(s.action_id)) return true;
    dropped.push(`unknown action id ${s.action_id}`);
    return false;
  });
  return {
    value: {
      summary: String(raw?.summary ?? ''),
      root_cause: { statement: String(rc.statement ?? ''), confidence, evidence_ids: cited, assumptions: rc.assumptions ?? [] },
      next_steps: steps,
      unknowns: raw?.unknowns ?? [],
    },
    dropped,
  };
}

/** Calls Claude. Returns { ok: true, value, dropped, model } or { ok: false, error }. Never throws. */
export async function askClaude(result, { model = process.env.AGENT_MODEL || DEFAULT_MODEL, importSdk = () => import('@anthropic-ai/sdk') } = {}) {
  let Anthropic;
  try { ({ default: Anthropic } = await importSdk()); }
  catch { return { ok: false, error: 'The Anthropic SDK is not installed. Run: cd agent && npm install' }; }

  try {
    const client = new Anthropic(); // credentials: ANTHROPIC_API_KEY, or an `ant auth login` profile
    const response = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if a safety classifier declines, the API retries on another model
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(result) }],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    });
    if (response.stop_reason === 'refusal') return { ok: false, error: `The model declined to answer (${response.stop_details?.category ?? 'refusal'}).` };
    if (response.stop_reason === 'max_tokens') return { ok: false, error: 'The model response was cut off (max_tokens).' };
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return { ok: false, error: 'The model returned no text.' };
    const checked = validateLlmOutput(JSON.parse(text), {
      evidenceIds: new Set(result.evidence.map((e) => e.id)),
      actionIds: new Set(result.actions.map((a) => a.id)),
    });
    return { ok: true, model: response.model ?? model, ...checked };
  } catch (e) {
    const status = e?.status ? ` (HTTP ${e.status})` : '';
    return { ok: false, error: `${e?.name ?? 'Error'}${status}: ${redact(e?.message ?? String(e))}` };
  }
}
