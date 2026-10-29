#!/bin/sh
# Applies both roles. Run it with YOUR admin kubeconfig (the Minikube one).
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
CTX="${KUBE_CONTEXT:-minikube}"
KC="kubectl --context $CTX"

$KC apply -f "$DIR/../namespace.yaml"
$KC apply -f "$DIR/admin-access.yaml"
$KC apply -f "$DIR/ai-agent.yaml"
if $KC get namespace ingress-nginx >/dev/null 2>&1; then
  $KC apply -f "$DIR/ai-agent-ingress-read.yaml"
else
  echo "apply: namespace ingress-nginx not found - skipping ai-agent-ingress-read.yaml (re-run after: minikube addons enable ingress)"
fi
echo "apply: done. Next: sh k8s/rbac/verify.sh  and  sh k8s/rbac/make-kubeconfig.sh"
