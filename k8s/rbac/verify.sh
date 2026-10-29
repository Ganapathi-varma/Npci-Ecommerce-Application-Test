#!/bin/sh
# Proves what each role can and cannot do, using `kubectl auth can-i` (impersonation; run with your admin kubeconfig).
set -u
CTX="${KUBE_CONTEXT:-minikube}"
NS="${NAMESPACE:-npci-ecommerce}"
KC="kubectl --context $CTX"
SA="system:serviceaccount:$NS:ai-agent"
FAIL=0

expect() {  # expect <yes|no> <who-args...> -- <verb> <resource> [namespace]
  want="$1"; shift
  got=$($KC auth can-i "$@" 2>/dev/null || true)
  if [ "$got" = "$want" ]; then printf '  ok    %-3s  can-i %s\n' "$got" "$*"; else printf '  FAIL  got=%s want=%s  can-i %s\n' "$got" "$want" "$*"; FAIL=1; fi
}

echo "== ROLE 1: admin (minikube-user) - everything"
expect yes --as=minikube-user '*' '*' --all-namespaces
expect yes --as=minikube-user create secrets -n "$NS"
expect yes --as=minikube-user delete namespaces

echo "== ROLE 2: ai-agent ServiceAccount - read"
for r in pods pods/log events services endpoints; do expect yes --as="$SA" get "$r" -n "$NS"; done
expect yes --as="$SA" list deployments.apps -n "$NS"
expect yes --as="$SA" list ingresses.networking.k8s.io -n "$NS"
expect yes --as="$SA" get nodes

echo "== ROLE 2: ai-agent ServiceAccount - write (only after human approval in the agent)"
expect yes --as="$SA" patch deployments.apps -n "$NS"
expect yes --as="$SA" patch deployments.apps/scale -n "$NS"
expect yes --as="$SA" delete pods -n "$NS"

echo "== ROLE 2: ai-agent ServiceAccount - must be denied"
expect no  --as="$SA" get secrets -n "$NS"
expect no  --as="$SA" list secrets -n "$NS"
expect no  --as="$SA" create deployments.apps -n "$NS"
expect no  --as="$SA" delete deployments.apps -n "$NS"
expect no  --as="$SA" create pods/exec -n "$NS"
expect no  --as="$SA" create rolebindings.rbac.authorization.k8s.io -n "$NS"
expect no  --as="$SA" patch deployments.apps -n kube-system
expect no  --as="$SA" get pods -n kube-system
expect no  --as="$SA" delete nodes

[ "$FAIL" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
