// Deterministic diagnosis. Turns a collected evidence bundle into findings.
//
// Rules of the game (they are what makes the output trustworthy):
//   * Every statement a finding makes about the system cites evidence ids (E1, E2...), and each evidence item is a
//     fact that was directly observed (a kubectl field, an event, a log line, an HTTP result, a CI stage result).
//   * Anything the finding needs but did NOT observe is written into `assumptions`.
//   * status = "confirmed" only when no assumptions were needed; "likely" = observed facts + stated assumptions;
//     "hypothesis" = little or no direct evidence.
//   * Things that could not be observed (forbidden, missing file...) are reported under `unknowns`, never guessed.
import { buildAction } from './actions.js';
import { truncate } from './util.js';

const IMAGE_ERRORS = ['ImagePullBackOff', 'ErrImagePull', 'ErrImageNeverPull', 'InvalidImageName'];
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function analyze(bundle) {
  const ctx = makeContext(bundle);

  analyzeCi(ctx);
  analyzeCluster(ctx);
  analyzeHealth(ctx);

  ctx.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    generatedAt: bundle.collectedAt,
    namespace: bundle.namespace,
    identity: bundle.identity,
    overall: overallStatus(ctx),
    findings: ctx.findings,
    evidence: ctx.evidence,
    actions: ctx.actions,
    unknowns: [...new Set(ctx.unknowns)],
  };
}

// ---------------------------------------------------------------- context / helpers
function makeContext(bundle) {
  const evidence = [];
  const findings = [];
  const actions = [];
  const unknowns = [];
  const seenActions = new Map();

  const ctx = {
    bundle, evidence, findings, actions, unknowns, ns: bundle.namespace, k: bundle.kube,
    ev(source, fact) {
      const hit = evidence.find((e) => e.source === source && e.fact === fact);
      if (hit) return hit.id;
      const id = `E${evidence.length + 1}`;
      evidence.push({ id, source, fact: truncate(fact, 400) });
      return id;
    },
    finding(f) {
      const assumptions = f.assumptions ?? [];
      const evidenceIds = [...new Set(f.evidence ?? [])];
      const status = f.status ?? (evidenceIds.length === 0 ? 'hypothesis' : assumptions.length === 0 ? 'confirmed' : 'likely');
      const id = `F${findings.length + 1}`;
      findings.push({
        id, title: f.title, severity: f.severity, status, conclusion: f.conclusion,
        evidence: evidenceIds, assumptions, actions: [], manual: f.manual ?? [], area: f.area ?? 'cluster',
      });
      return id;
    },
    /** Proposes a catalogued, approval-gated change. Duplicate proposals collapse into one action. */
    propose(findingId, type, params, reason, evidenceIds = []) {
      let built;
      try { built = buildAction(type, params, ctx.ns); }
      catch (e) { unknowns.push(`Could not propose ${type}: ${e.message}`); return null; }
      const key = `${type}|${JSON.stringify(built.params)}`;
      let action = seenActions.get(key);
      if (!action) {
        action = { ...built, id: `A${actions.length + 1}`, reason, evidence: [...evidenceIds], findingId };
        seenActions.set(key, action);
        actions.push(action);
      }
      const f = findings.find((x) => x.id === findingId);
      if (f && !f.actions.includes(action.id)) f.actions.push(action.id);
      return action.id;
    },
  };
  for (const e of bundle.kube?.errors ?? []) unknowns.push(`Could not read "${e.what}": ${e.error}`);
  return ctx;
}

const podName = (p) => p.metadata?.name ?? '?';
const deploymentOf = (pod) => {
  const rs = (pod.metadata?.ownerReferences ?? []).find((o) => o.kind === 'ReplicaSet');
  return rs ? rs.name.replace(/-[a-z0-9]{6,10}$/, '') : null;
};
const statuses = (pod) => [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
const restartCount = (pod) => statuses(pod).reduce((n, c) => n + (c.restartCount ?? 0), 0);
const isReady = (pod) => pod.status?.phase === 'Running' && statuses(pod).length > 0 && statuses(pod).every((c) => c.ready);
const warningsFor = (ctx, pod) => (ctx.k.events ?? []).filter((e) => e.type === 'Warning' && e.involvedObject?.name === podName(pod));

function previousRevisionHealthy(ctx, deployment) {
  const sets = (ctx.k.replicaSets ?? []).filter((rs) => rs.metadata?.ownerReferences?.some((o) => o.name === deployment));
  const others = sets.filter((rs) => (rs.spec?.replicas ?? 0) === 0 && (rs.status?.observedGeneration ?? 0) > 0);
  return { revisions: sets.length, candidate: others.length > 0 };
}

// ---------------------------------------------------------------- CI
function analyzeCi(ctx) {
  const ci = ctx.bundle.ci;
  if (!ci?.present) { ctx.unknowns.push(`CI status not available (${ci?.reason ?? 'not provided'})`); return; }
  const s = ci.status;
  const src = `ci-status.json (job ${s.job}, build #${s.build_number})`;
  if (s.result === 'SUCCESS') {
    ctx.ev(src, `Build #${s.build_number} finished with result SUCCESS (image ${s.image || 'n/a'}, commit ${s.commit}).`);
    return;
  }
  const failed = Object.entries(s.stages ?? {}).filter(([, v]) => v !== 'SUCCESS').map(([k]) => k);
  const resultEv = ctx.ev(src, `Build #${s.build_number} finished with result ${s.result}; failed stage(s): ${failed.join(', ') || 'none recorded'}.`);
  ctx.unknowns.push('Jenkins console output was not provided, so the exact error inside a failed CI stage is not known.');

  for (const stage of failed.length ? failed : ['(unspecified)']) {
    const stageEv = ctx.ev(src, `Stage "${stage}" = ${s.stages?.[stage] ?? 'unknown'}.`);
    const evidence = [resultEv, stageEv];
    const manual = [];
    let conclusion = `CI stage "${stage}" failed, so the pipeline did not complete.`;
    let severity = 'high';

    if (stage === 'Unit Tests') manual.push('Run `npm test` (or `npx ng test --watch=false --browsers=ChromeHeadlessCI --karma-config=ci/karma.ci.conf.js`) locally and open the Jenkins console for the failing spec.');
    else if (stage === 'Docker Build') manual.push('Open the Jenkins console at the failing Dockerfile step; run `docker build .` locally to reproduce.');
    else if (stage === 'Docker Push') manual.push('Check that the Jenkins credential `dockerhub-token` is valid, has Read & Write scope, and that DOCKER_USERNAME / IMAGE_REPO match your Docker Hub account.');
    else if (stage === 'Deploy to Minikube') manual.push('The deploy stage failed; see the cluster findings in this report and `kubectl -n npci-ecommerce get pods`.');
    else if (stage === 'Vulnerability Scan') {
      const t = ci.trivy;
      if (t) {
        const hi = (t.counts.HIGH ?? 0) + (t.counts.CRITICAL ?? 0);
        const tEv = ctx.ev(`trivy report (${t.file})`, `${t.counts.CRITICAL ?? 0} CRITICAL and ${t.counts.HIGH ?? 0} HIGH findings in total; ${t.fixable.length} of them have a fixed version available. Top packages: ${[...new Set(t.fixable.map((v) => v.pkg))].slice(0, 6).join(', ') || 'n/a'}.`);
        evidence.push(tEv);
        conclusion = `The vulnerability scan gate failed: ${t.fixable.length} fixable HIGH/CRITICAL vulnerabilities (${hi} HIGH+CRITICAL in total).`;
        manual.push('Rebuild with `docker build --pull` (the Dockerfile runs `apk upgrade`) so OS packages pick up the fixed versions, then re-scan.');
        manual.push('If a fix is not yet published for the base image, either pin a newer base image tag or run once with FAIL_ON_VULN unticked and track the CVEs.');
      } else {
        manual.push('Open `reports/trivy-report.txt` from the Jenkins build artifacts for the package list.');
      }
    } else severity = 'medium';

    ctx.finding({ title: `CI failure: ${stage}`, severity, conclusion, evidence, manual, area: 'ci' });
  }
}

// ---------------------------------------------------------------- cluster
function analyzeCluster(ctx) {
  const k = ctx.k;
  if (!k) return;

  if (k.namespaceExists === false) {
    const e = ctx.ev(`kubectl get namespace ${ctx.ns}`, `Namespace "${ctx.ns}" does not exist (NotFound).`);
    ctx.finding({
      title: 'Application is not deployed', severity: 'high', evidence: [e],
      conclusion: `The namespace ${ctx.ns} does not exist, so none of the application is running.`,
      manual: ['Deploy it: `API_URL=/api/ sh k8s/deploy.sh <image:tag>` (needs your admin kubeconfig; the agent cannot do this).'],
    });
    return;
  }
  if (k.namespaceExists === null) { ctx.unknowns.push(`Could not confirm that namespace ${ctx.ns} exists; cluster state is unknown.`); return; }

  if ((k.deployments ?? []).length === 0 && (k.errors ?? []).every((e) => !/deployments/.test(e.what))) {
    const e = ctx.ev(`kubectl get deployments -n ${ctx.ns}`, 'No deployments found in the namespace.');
    ctx.finding({
      title: 'Namespace exists but nothing is deployed', severity: 'high', evidence: [e],
      conclusion: `${ctx.ns} exists but has no Deployments.`,
      manual: ['Deploy it: `API_URL=/api/ sh k8s/deploy.sh <image:tag>`.'],
    });
  }

  const covered = new Set(); // deployments that already have a specific explanation
  imagePullProblems(ctx, covered);
  missingConfig(ctx, covered);
  crashes(ctx, covered);
  scheduling(ctx, covered);
  readiness(ctx, covered);
  rolloutStuck(ctx, covered);
  unavailableDeployments(ctx, covered);
  emptyEndpoints(ctx);
  frequentRestarts(ctx);
  ingressController(ctx);
  logStatistics(ctx);

  const healthyDeployments = (k.deployments ?? []).filter((d) => (d.status?.availableReplicas ?? 0) >= (d.spec?.replicas ?? 1));
  if (healthyDeployments.length) {
    ctx.ev('kubectl get deployments', `Fully available: ${healthyDeployments.map((d) => `${d.metadata.name} (${d.status.availableReplicas ?? 0}/${d.spec.replicas})`).join(', ')}.`);
  }
}

function imagePullProblems(ctx, covered) {
  const groups = new Map();
  for (const pod of ctx.k.pods ?? []) {
    for (const c of statuses(pod)) {
      const reason = c.state?.waiting?.reason;
      if (!IMAGE_ERRORS.includes(reason)) continue;
      const key = `${deploymentOf(pod)}|${c.image}`;
      if (!groups.has(key)) groups.set(key, { deployment: deploymentOf(pod), image: c.image, reason, pods: [] });
      groups.get(key).pods.push({ pod, container: c });
    }
  }
  for (const g of groups.values()) {
    const evidence = [];
    for (const { pod, container } of g.pods) {
      evidence.push(ctx.ev(`pod/${podName(pod)}`, `container "${container.name}" is waiting with reason ${container.state.waiting.reason} (image ${container.image}).`));
    }
    const messages = g.pods.flatMap(({ pod }) => warningsFor(ctx, pod).filter((e) => /pull|image|Never/i.test(`${e.reason} ${e.message}`)));
    for (const m of messages.slice(0, 2)) evidence.push(ctx.ev('kubernetes event', `${m.reason}: ${m.message}`));
    const text = messages.map((m) => m.message).join(' ');

    let conclusion; const assumptions = [];
    if (/not present with pull policy of Never/i.test(text)) {
      conclusion = `Image ${g.image} is not present on the node and the pod's pull policy forbids pulling it.`;
    } else if (/pull access denied|repository does not exist|manifest unknown|not found|denied/i.test(text)) {
      conclusion = `The registry cannot serve image ${g.image} (not found, or access denied for this node).`;
    } else {
      conclusion = `The node cannot obtain image ${g.image}.`;
      assumptions.push(`Image ${g.image} was never loaded into Minikube (minikube image load) or pushed to a registry the node can reach.`);
    }
    const manual = [
      `Load or push the image the deployment expects: \`minikube image load ${g.image}\` (needs Docker access) or \`docker push\` it, then re-run \`sh k8s/deploy.sh ${g.image}\`.`,
    ];
    const id = ctx.finding({ title: `Image cannot be pulled (${g.deployment ?? 'unknown deployment'})`, severity: 'critical', conclusion, evidence, assumptions, manual });
    if (g.deployment) {
      covered.add(g.deployment);
      const prev = previousRevisionHealthy(ctx, g.deployment);
      if (prev.revisions > 1 && prev.candidate) {
        const rev = ctx.ev(`kubectl get replicasets`, `Deployment ${g.deployment} has ${prev.revisions} revisions (ReplicaSets); an older one exists to return to.`);
        ctx.propose(id, 'rollout-undo', { deployment: g.deployment }, 'Return to the previous revision, whose image was available, while the new image problem is fixed.', [...evidence, rev]);
      }
    }
  }
}

function missingConfig(ctx, covered) {
  const found = new Map();
  // Events are history (Kubernetes keeps them ~1h). Only trust one if its pod is STILL stuck before container start;
  // a pod that has moved on (e.g. now pulling its image) proves the mount problem has since been resolved.
  const stillBlocked = (podNameValue) => {
    const p = (ctx.k.pods ?? []).find((x) => podName(x) === podNameValue);
    if (!p) return false;
    const s = statuses(p);
    return s.length === 0 || s.some((c) => ['ContainerCreating', 'CreateContainerConfigError', 'PodInitializing'].includes(c.state?.waiting?.reason));
  };
  for (const e of ctx.k.events ?? []) {
    const m = /(secret|configmap) "([^"]+)" not found/i.exec(e.message ?? '');
    if (m && e.type === 'Warning' && e.involvedObject?.kind === 'Pod' && stillBlocked(e.involvedObject.name)) {
      found.set(`${m[1].toLowerCase()}/${m[2]}`, { kind: m[1].toLowerCase(), name: m[2], event: e });
    }
  }
  for (const pod of ctx.k.pods ?? []) {
    for (const c of statuses(pod)) {
      if (c.state?.waiting?.reason === 'CreateContainerConfigError' && /secret|configmap/i.test(c.state.waiting.message ?? '')) {
        const m = /(secret|configmap) "([^"]+)"/i.exec(c.state.waiting.message);
        if (m) found.set(`${m[1].toLowerCase()}/${m[2]}`, { kind: m[1].toLowerCase(), name: m[2], pod, container: c });
      }
    }
  }
  for (const [key, f] of found) {
    const evidence = [];
    if (f.event) evidence.push(ctx.ev('kubernetes event', `${f.event.reason} on ${f.event.involvedObject?.kind}/${f.event.involvedObject?.name}: ${f.event.message}`));
    if (f.pod) evidence.push(ctx.ev(`pod/${podName(f.pod)}`, `container "${f.container.name}" is waiting: CreateContainerConfigError - ${f.container.state.waiting.message}`));
    for (const pod of ctx.k.pods ?? []) { const d = deploymentOf(pod); if (d) covered.add(d); }
    ctx.finding({
      title: `Required ${f.kind} "${f.name}" is missing`, severity: 'critical', evidence,
      conclusion: `Pods cannot start because the ${f.kind} "${f.name}" they mount does not exist in ${ctx.ns}.`,
      manual: [f.kind === 'secret'
        ? 'Create it with your admin kubeconfig: `API_URL=/api/ sh k8s/deploy.sh <image:tag>` (the agent has no access to Secrets by design).'
        : `Create the ConfigMap ${f.name} (or fix the volume reference in k8s/deployment.yaml).`],
    });
  }
}

function crashes(ctx, covered) {
  const groups = new Map();
  for (const pod of ctx.k.pods ?? []) {
    for (const c of statuses(pod)) {
      const term = c.state?.terminated ?? c.lastState?.terminated;
      const crashing = c.state?.waiting?.reason === 'CrashLoopBackOff' || (term && term.exitCode !== 0 && (c.restartCount ?? 0) > 0);
      if (!crashing) continue;
      const dep = deploymentOf(pod);
      if (!groups.has(dep)) groups.set(dep, []);
      groups.get(dep).push({ pod, c, term });
    }
  }
  for (const [dep, items] of groups) {
    const evidence = []; const assumptions = []; const manual = [];
    let cause = null;
    for (const { pod, c, term } of items) {
      const exit = term ? `last exit: reason=${term.reason ?? 'n/a'} code=${term.exitCode}` : 'no termination record';
      evidence.push(ctx.ev(`pod/${podName(pod)}`, `container "${c.name}" restarted ${c.restartCount}x, state ${c.state?.waiting?.reason ?? 'terminated'}, ${exit}.`));
      const logs = ctx.k.logs?.[podName(pod)];
      const text = `${logs?.previous ?? ''}\n${logs?.current ?? ''}`;
      const lines = text.split('\n').filter((l) => /\[emerg\]|\[crit\]|\berror\b|fatal|denied|read-only|cannot|failed/i.test(l)).slice(-3);
      for (const l of lines) evidence.push(ctx.ev(`logs of pod/${podName(pod)}`, l.trim()));
      if (term?.reason === 'OOMKilled') {
        const limit = pod.spec?.containers?.find((x) => x.name === c.name)?.resources?.limits?.memory;
        evidence.push(ctx.ev(`pod/${podName(pod)} spec`, `memory limit of "${c.name}" = ${limit ?? 'not set'}.`));
        cause ??= `The container was killed for exceeding its memory limit (${limit ?? 'unset'}).`;
        manual.push('Raise `resources.limits.memory` in k8s/deployment.yaml and re-deploy (this is a spec change, outside what the agent may do).');
      } else if (lines.some((l) => /\[emerg\]/.test(l))) {
        cause ??= 'nginx refused to start because of a configuration error shown in its log.';
        manual.push('Fix docker/nginx.conf (check the [emerg] line), rebuild the image and re-deploy.');
      } else if (lines.some((l) => /read-only file system/i.test(l))) {
        const ro = pod.spec?.containers?.find((x) => x.name === c.name)?.securityContext?.readOnlyRootFilesystem;
        evidence.push(ctx.ev(`pod/${podName(pod)} spec`, `readOnlyRootFilesystem = ${ro}.`));
        cause ??= 'The process tried to write to a read-only filesystem.';
        manual.push('Add an emptyDir volume for the path being written (see /tmp in k8s/deployment.yaml), or set readOnlyRootFilesystem: false.');
      }
    }
    if (!cause) {
      cause = 'The container keeps exiting; the available logs do not show why.';
      assumptions.push('The failure comes from the application or its configuration rather than from the cluster (not verifiable from this evidence).');
    }
    if (dep) covered.add(dep);
    const id = ctx.finding({ title: `Container crash loop (${dep ?? 'unknown deployment'})`, severity: 'critical', conclusion: cause, evidence, assumptions, manual });
    const prev = dep ? previousRevisionHealthy(ctx, dep) : { candidate: false };
    if (dep && prev.candidate) ctx.propose(id, 'rollout-undo', { deployment: dep }, 'Return to the previous revision, which did not crash.', evidence);
  }
}

function scheduling(ctx, covered) {
  for (const pod of ctx.k.pods ?? []) {
    if (pod.status?.phase !== 'Pending') continue;
    const ev = warningsFor(ctx, pod).find((e) => e.reason === 'FailedScheduling');
    if (!ev) continue;
    const dep = deploymentOf(pod);
    const evidence = [
      ctx.ev(`pod/${podName(pod)}`, 'phase is Pending (not scheduled to any node).'),
      ctx.ev('kubernetes event', `FailedScheduling: ${ev.message}`),
    ];
    if (dep) covered.add(dep);
    const insufficient = /Insufficient (cpu|memory)/i.exec(ev.message ?? '');
    const id = ctx.finding({
      title: `Pod cannot be scheduled (${dep ?? 'unknown deployment'})`, severity: 'high', evidence,
      conclusion: insufficient ? `The node does not have enough ${insufficient[1]} for the pod's requests.` : 'The scheduler cannot place the pod (see event).',
      manual: insufficient ? ['Free capacity (stop other workloads), lower the requests in k8s/deployment.yaml, or start Minikube with more CPU/memory.'] : [],
    });
    const d = (ctx.k.deployments ?? []).find((x) => x.metadata.name === dep);
    if (insufficient && d && (d.spec.replicas ?? 1) > 1) {
      ctx.propose(id, 'scale', { deployment: dep, replicas: d.spec.replicas - 1 }, `Reduce replicas from ${d.spec.replicas} to ${d.spec.replicas - 1} so the remaining pods fit on the node (reduces capacity).`, evidence);
    }
  }
}

function readiness(ctx, covered) {
  const groups = new Map();
  for (const pod of ctx.k.pods ?? []) {
    if (pod.status?.phase !== 'Running' || isReady(pod)) continue;
    if (statuses(pod).some((c) => c.state?.waiting)) continue; // already explained by a waiting reason
    const dep = deploymentOf(pod);
    if (!groups.has(dep)) groups.set(dep, []);
    groups.get(dep).push(pod);
  }
  for (const [dep, pods] of groups) {
    const evidence = pods.map((p) => ctx.ev(`pod/${podName(p)}`, 'phase is Running but the container is not Ready.'));
    for (const p of pods) {
      const probe = warningsFor(ctx, p).find((e) => e.reason === 'Unhealthy');
      if (probe) evidence.push(ctx.ev('kubernetes event', `Unhealthy: ${probe.message}`));
    }
    if (dep) covered.add(dep);
    const id = ctx.finding({
      title: `Pods running but not Ready (${dep ?? 'unknown deployment'})`, severity: 'high', evidence,
      conclusion: 'The pods start but fail their readiness probe, so they receive no traffic.',
      assumptions: ['The application is genuinely unhealthy (not merely slow to start).'],
      manual: ['Check `kubectl -n npci-ecommerce logs <pod>` and that `/healthz` answers 200 inside the container.'],
    });
    if (dep) ctx.propose(id, 'rollout-restart', { deployment: dep }, 'Recycle the pods; only helps if the failure is transient.', evidence);
  }
}

function rolloutStuck(ctx, covered) {
  for (const d of ctx.k.deployments ?? []) {
    const cond = (d.status?.conditions ?? []).find((c) => c.type === 'Progressing' && c.status === 'False');
    if (!cond) continue;
    const evidence = [ctx.ev(`deployment/${d.metadata.name}`, `condition Progressing=False reason=${cond.reason}: ${cond.message}`)];
    const id = ctx.finding({
      title: `Rollout is stuck (${d.metadata.name})`, severity: 'high', evidence,
      conclusion: `The latest rollout of ${d.metadata.name} did not complete within its progress deadline.`,
    });
    covered.add(d.metadata.name);
    if (previousRevisionHealthy(ctx, d.metadata.name).candidate) {
      ctx.propose(id, 'rollout-undo', { deployment: d.metadata.name }, 'Abandon the stuck revision and return to the previous one.', evidence);
    }
  }
}

function unavailableDeployments(ctx, covered) {
  for (const d of ctx.k.deployments ?? []) {
    const want = d.spec?.replicas ?? 1; const have = d.status?.availableReplicas ?? 0;
    if (have >= want || covered.has(d.metadata.name) || want === 0) continue;
    const evidence = [ctx.ev(`deployment/${d.metadata.name}`, `desired replicas=${want}, available=${have}.`)];
    ctx.finding({
      title: `Deployment not fully available (${d.metadata.name})`, severity: have === 0 ? 'critical' : 'medium', evidence,
      conclusion: `${d.metadata.name} has ${have} of ${want} replicas available, but no more specific cause was found in pods or events.`,
      assumptions: ['The shortfall is recent (a rollout may still be in progress).'],
      status: 'hypothesis',
    });
  }
}

function emptyEndpoints(ctx) {
  for (const svc of ctx.k.services ?? []) {
    if (!svc.spec?.selector || svc.spec.type === 'ExternalName') continue;
    const ep = (ctx.k.endpoints ?? []).find((e) => e.metadata.name === svc.metadata.name);
    const ready = (ep?.subsets ?? []).reduce((n, s) => n + (s.addresses?.length ?? 0), 0);
    if (ready > 0) continue;
    const backing = (ctx.k.deployments ?? []).filter((d) => Object.entries(svc.spec.selector).every(([k2, v]) => d.spec?.template?.metadata?.labels?.[k2] === v));
    if (!backing.some((d) => (d.spec?.replicas ?? 0) > 0)) continue;
    const e = ctx.ev(`endpoints/${svc.metadata.name}`, 'has 0 ready addresses.');
    ctx.finding({
      title: `Service ${svc.metadata.name} has no ready endpoints`, severity: 'high', evidence: [e],
      conclusion: `Traffic to service ${svc.metadata.name} (and any Ingress path pointing at it) will fail: no pod is ready behind it.`,
      assumptions: ['Clients reach this service through the Ingress or directly in-cluster.'],
    });
  }
}

function frequentRestarts(ctx) {
  for (const pod of ctx.k.pods ?? []) {
    if (!isReady(pod) || restartCount(pod) < 3) continue;
    const e = ctx.ev(`pod/${podName(pod)}`, `Ready now, but restarted ${restartCount(pod)} times.`);
    ctx.finding({
      title: `Pod restarted repeatedly (${podName(pod)})`, severity: 'medium', evidence: [e],
      conclusion: 'The pod is healthy now but has restarted several times; something intermittently kills it.',
      status: 'hypothesis', assumptions: ['The earlier restarts and the current state share one cause (unknown).'],
    });
  }
}

function ingressController(ctx) {
  const k = ctx.k;
  if ((k.ingresses ?? []).length === 0) return;
  const ic = k.ingressController;
  if (ic.namespaceExists === null) { ctx.unknowns.push('Could not check for an ingress controller (no read access to the ingress-nginx namespace).'); return; }
  const running = (ic.pods ?? []).filter((p) => isReady(p));
  const ing = ctx.ev(`kubectl get ingresses -n ${ctx.ns}`, `Ingress resource(s) present: ${k.ingresses.map((i) => i.metadata.name).join(', ')}.`);
  if (ic.namespaceExists === false || running.length === 0) {
    const e = ctx.ev('kubectl get pods -n ingress-nginx', ic.namespaceExists === false ? 'Namespace ingress-nginx does not exist.' : 'No ready ingress-nginx controller pods.');
    ctx.finding({
      title: 'No ingress controller is running', severity: 'high', evidence: [ing, e],
      conclusion: 'Ingress rules exist but nothing is serving them, so path-based routing (/, /products, /api) cannot work.',
      manual: ['Enable it: `minikube addons enable ingress`, then re-apply RBAC with `sh k8s/rbac/apply.sh` so the agent can read it.'],
    });
  } else {
    ctx.ev('kubectl get pods -n ingress-nginx', `${running.length} ingress controller pod(s) Ready.`);
  }
}

// ---------------------------------------------------------------- logs
export function parseAccessLine(line) {
  const t = line.trim();
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); const status = Number(j.status); if (status) return { status, path: String(j.uri ?? j.request_uri ?? j.path ?? '') }; } catch { /* not json */ }
  }
  const m = /"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/[\d.]+" (\d{3})/.exec(t);
  return m ? { status: Number(m[2]), path: m[1] } : null;
}

function logStatistics(ctx) {
  const sources = Object.entries(ctx.k.logs ?? {}).map(([pod, l]) => [`logs of pod/${pod}`, l.current]);
  if (ctx.k.ingressController?.logs) sources.push(['logs of ingress-nginx controller', ctx.k.ingressController.logs]);
  for (const [source, text] of sources) {
    const hits = (text ?? '').split('\n').map(parseAccessLine).filter(Boolean);
    const errors = hits.filter((h) => h.status >= 500);
    if (errors.length === 0) continue;
    const byKey = new Map();
    for (const h of errors) { const key = `${h.status} ${h.path.split('?')[0]}`; byKey.set(key, (byKey.get(key) ?? 0) + 1); }
    const top = [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k2, n]) => `${k2} x${n}`).join(', ');
    const e = ctx.ev(source, `${errors.length} of ${hits.length} logged requests returned HTTP 5xx. Most frequent: ${top}.`);
    const api = errors.some((h) => h.path.startsWith('/api'));
    ctx.finding({
      title: 'HTTP 5xx responses in access logs', severity: 'medium', evidence: [e],
      conclusion: api ? 'Requests to /api are failing with 5xx; the Ingress could not get a good answer from the backend.' : 'The web tier is returning 5xx for some requests.',
      assumptions: api ? ['The external backend (Render) is cold-starting, unreachable, or rejecting the proxied request - the logs alone do not say which.'] : ['The errors are from the application, not from clients sending bad requests.'],
    });
  }
}

// ---------------------------------------------------------------- health checks
function analyzeHealth(ctx) {
  const checks = ctx.bundle.health ?? [];
  if (checks.length === 0) { ctx.unknowns.push('No health-check URLs were given (--url), so end-to-end reachability was not tested.'); return; }
  const noController = ctx.findings.find((f) => f.title === 'No ingress controller is running');
  for (const h of checks) {
    if (h.ok) { ctx.ev(`GET ${h.url}`, `HTTP ${h.status} in ${h.ms} ms.`); continue; }
    const e = ctx.ev(`GET ${h.url}`, h.status ? `HTTP ${h.status} in ${h.ms} ms.` : `request failed after ${h.ms} ms: ${h.error}`);
    const evidence = [e]; const assumptions = []; let conclusion; let severity = 'high';
    if (!h.status && noController) {
      evidence.push(...noController.evidence);
      conclusion = 'The health endpoint is unreachable, consistent with the missing ingress controller.';
      assumptions.push(`${h.url} is routed through the Ingress controller.`);
    } else if (!h.status) {
      conclusion = `The health endpoint ${h.url} could not be reached (${h.error}).`;
      assumptions.push('The URL and network path are correct (the agent cannot tell a wrong address from an outage).');
    } else if (h.status === 404) {
      conclusion = 'The endpoint answered 404: something is listening but no Ingress rule or route matches this path.';
      assumptions.push('The 404 comes from the ingress default backend rather than from the application.');
    } else if (h.status === 503) {
      conclusion = 'The endpoint answered 503: the router has no ready backend for this path.';
      assumptions.push('The responder is the ingress controller, not the application.');
    } else {
      conclusion = `The health endpoint answered HTTP ${h.status}.`;
      if (h.status < 500) severity = 'medium';
    }
    ctx.finding({ title: `Health check failing: ${h.url}`, severity, evidence, assumptions, conclusion, area: 'health' });
  }
}

// ---------------------------------------------------------------- summary
function overallStatus(ctx) {
  const k = ctx.k;
  const runtime = ctx.findings.filter((f) => f.area !== 'ci' && ['critical', 'high'].includes(f.severity));
  const deployments = k?.deployments ?? [];
  if (deployments.length > 0 && deployments.every((d) => (d.status?.availableReplicas ?? 0) === 0)) return 'down';
  if (k?.namespaceExists === false) return 'down';
  if (runtime.length > 0) return 'degraded';
  if (ctx.findings.some((f) => f.area === 'ci' && ['critical', 'high'].includes(f.severity))) return 'ci-failed';
  if (k && k.namespaceExists === null && !ctx.bundle.health?.length && !ctx.bundle.ci?.present) return 'unknown';
  return ctx.findings.length === 0 ? 'healthy' : 'degraded';
}
