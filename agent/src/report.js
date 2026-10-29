// Plain-text report. Keeps "what was observed" visibly separate from "what is assumed".
const BADGE = { confirmed: 'CONFIRMED', likely: 'LIKELY (rests on assumptions)', hypothesis: 'HYPOTHESIS (weak evidence)' };

export function renderText(result, { llm } = {}) {
  const out = [];
  const line = (s = '') => out.push(s);
  const rule = '='.repeat(78);

  line(rule);
  line(`INCIDENT DIAGNOSIS   namespace: ${result.namespace}   ${result.generatedAt}`);
  line(`Running as: ${result.identity ?? 'unknown identity'}`);
  line(`OVERALL STATUS: ${result.overall.toUpperCase()}`);
  line(rule);

  if (llm?.ok) {
    line('\nAI SUMMARY (advisory, produced by ' + llm.model + '; the evidence-based findings below are authoritative)');
    line(`  ${llm.value.summary}`);
    const rc = llm.value.root_cause;
    if (rc.statement) {
      line(`  Likely root cause [confidence: ${rc.confidence}]: ${rc.statement}`);
      line(`    cites: ${rc.evidence_ids.join(', ') || '(no valid evidence cited)'}`);
      for (const a of rc.assumptions) line(`    assumption: ${a}`);
    }
    for (const d of llm.dropped) line(`  (validator removed: ${d})`);
  } else if (llm && !llm.ok) {
    line(`\nAI SUMMARY unavailable: ${llm.error}\n(Continuing with the rule-based diagnosis, which does not need it.)`);
  }

  line('\nFINDINGS');
  if (result.findings.length === 0) line('  No faults detected in the evidence that could be collected.');
  for (const f of result.findings) {
    line(`\n [${f.id}] ${f.severity.toUpperCase()}  ${BADGE[f.status]}  -  ${f.title}`);
    line(`   Conclusion : ${f.conclusion}`);
    line(`   Evidence   : ${f.evidence.length ? f.evidence.join(', ') : '(none)'}`);
    if (f.assumptions.length) for (const a of f.assumptions) line(`   Assumption : ${a}`);
    else line('   Assumption : none needed');
    if (f.actions.length) line(`   Proposed   : ${f.actions.join(', ')}  (changes the cluster; needs your approval)`);
    for (const m of f.manual) line(`   Manual step: ${m}`);
  }

  line('\nEVIDENCE (directly observed facts)');
  for (const e of result.evidence) line(`  ${e.id.padEnd(4)} ${e.source}: ${e.fact}`);

  if (result.unknowns.length) {
    line('\nNOT OBSERVED / UNKNOWN');
    for (const u of result.unknowns) line(`  - ${u}`);
  }

  line('\nRECOMMENDED PLAN');
  const manual = result.findings.flatMap((f) => f.manual.map((m) => ({ f: f.id, m })));
  let n = 1;
  if (manual.length === 0 && result.actions.length === 0) line('  Nothing to do.');
  for (const { f, m } of manual) line(`  ${n++}. [manual - outside the agent's permissions] (${f}) ${m}`);
  const order = llm?.ok ? llm.value.next_steps.map((s) => s.action_id) : [];
  const ranked = [...result.actions].sort((a, b) => {
    const ia = order.indexOf(a.id); const ib = order.indexOf(b.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const a of ranked) {
    const why = llm?.ok ? llm.value.next_steps.find((s) => s.action_id === a.id)?.rationale : null;
    line(`  ${n++}. [CHANGES THE CLUSTER - needs "APPROVE ${a.id}"] ${a.description}`);
    line(`        why: ${why ?? a.reason}`);
    line(`        cmd: ${a.display}   risk: ${a.risk}   rollback: ${a.rollback}`);
  }
  if (result.actions.length) line('\n  To review these one by one:  node bin/ai-agent.js diagnose --apply   (interactive terminal required)');
  line('');
  return out.join('\n');
}
