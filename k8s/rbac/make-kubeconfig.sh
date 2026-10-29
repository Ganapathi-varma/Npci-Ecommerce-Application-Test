#!/bin/sh
# Builds a kubeconfig for the ai-agent ServiceAccount from YOUR Minikube kubeconfig (server + CA are copied from it).
# The token is short-lived (TokenRequest API), so no long-lived secret is created; re-run this when it expires.
# Output stays outside the repo, mode 600. Usage: sh k8s/rbac/make-kubeconfig.sh [output-file]
set -eu
CTX="${KUBE_CONTEXT:-minikube}"
NS="${NAMESPACE:-npci-ecommerce}"
TTL="${TOKEN_TTL:-8h}"
OUT="${1:-$HOME/.kube/ai-agent.kubeconfig}"
KC="kubectl --context $CTX"

SERVER=$($KC config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')
CA_FILE=$($KC config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority}')
CA_DATA=$($KC config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
if [ -z "$CA_DATA" ] && [ -n "$CA_FILE" ]; then CA_DATA=$(base64 -w0 "$CA_FILE"); fi
[ -n "$SERVER" ] && [ -n "$CA_DATA" ] || { echo "make-kubeconfig: could not read server/CA from context $CTX" >&2; exit 1; }

TOKEN=$($KC -n "$NS" create token ai-agent --duration="$TTL")

umask 077
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<YAML
apiVersion: v1
kind: Config
clusters:
  - name: minikube
    cluster:
      server: $SERVER
      certificate-authority-data: $CA_DATA
users:
  - name: ai-agent
    user:
      token: $TOKEN
contexts:
  - name: ai-agent@minikube
    context:
      cluster: minikube
      user: ai-agent
      namespace: $NS
current-context: ai-agent@minikube
YAML
chmod 600 "$OUT"
echo "make-kubeconfig: wrote $OUT (token valid for $TTL). Use it with:  kubectl --kubeconfig $OUT get pods"
