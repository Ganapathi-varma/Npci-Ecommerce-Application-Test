#!/bin/sh
# Deploys the frontend image to Minikube (needs admin-level kubectl access; the AI agent cannot run this).
# Usage: sh k8s/deploy.sh <image:tag>        e.g. sh k8s/deploy.sh npci-ecommerce-frontend:12-ab12cd3
# Env:   API_URL            value stored in the Kubernetes Secret ecommerce-frontend-secret as assets/config.json
#                           ("/api/" for the Ingress path /api, or a full https:// URL). Never goes into git or the image.
#                           Optional when that Secret already exists in the cluster.
#        MINIKUBE_PROFILE   (default minikube)      NAMESPACE (default npci-ecommerce)
#        SKIP_IMAGE_LOAD=true  if the image is already inside Minikube
set -eu

IMAGE="${1:?usage: deploy.sh <image:tag>}"
PROFILE="${MINIKUBE_PROFILE:-minikube}"
NS="${NAMESPACE:-npci-ecommerce}"
DIR="$(cd "$(dirname "$0")" && pwd)"
KC="kubectl --context $PROFILE"

for tool in minikube kubectl; do
  command -v "$tool" >/dev/null || { echo "deploy: $tool not found in PATH" >&2; exit 1; }
done
minikube status -p "$PROFILE" >/dev/null 2>&1 || { echo "deploy: Minikube profile '$PROFILE' is not running (minikube start -p $PROFILE)" >&2; exit 1; }

if [ "${SKIP_IMAGE_LOAD:-false}" != "true" ]; then
  echo "deploy: loading $IMAGE into Minikube"
  minikube image load "$IMAGE" -p "$PROFILE"
fi

# Namespace first, so the Secret can live in it
$KC apply -f "$DIR/namespace.yaml" >/dev/null

SECRET=ecommerce-frontend-secret
EXISTED=no; $KC -n "$NS" get deployment ecommerce-customer >/dev/null 2>&1 && EXISTED=yes
if [ -n "${API_URL:-}" ]; then
  case "$API_URL" in /*|http://*|https://*) ;; *) echo "deploy: API_URL must start with /, http:// or https://" >&2; exit 1 ;; esac
  case "$API_URL" in *\"*|*\\*) echo "deploy: API_URL contains invalid characters" >&2; exit 1 ;; esac
  # Written to a private temp file so the value never appears in the process list or the logs
  OLD_UMASK=$(umask); umask 077
  TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
  printf '{\n  "apiUrl": "%s"\n}\n' "$API_URL" > "$TMP"
  umask "$OLD_UMASK"
  $KC -n "$NS" create secret generic "$SECRET" --from-file=config.json="$TMP" --dry-run=client -o yaml | $KC apply -f - >/dev/null
  echo "deploy: Secret $SECRET created/updated from API_URL"
elif $KC -n "$NS" get secret "$SECRET" >/dev/null 2>&1; then
  echo "deploy: API_URL not set, reusing existing Secret $SECRET"
else
  echo "deploy: Secret $SECRET does not exist - set API_URL (e.g. API_URL=/api/ sh k8s/deploy.sh <image>)" >&2
  exit 1
fi

echo "deploy: applying manifests with image $IMAGE"
sed "s#image: npci-ecommerce-frontend:latest#image: $IMAGE#" "$DIR/deployment.yaml" | $KC apply -f -
$KC apply -f "$DIR/service.yaml" -f "$DIR/ingress.yaml"

# A mounted Secret file (subPath) is not refreshed in running pods, so restart them when the value changed
if [ -n "${API_URL:-}" ] && [ "$EXISTED" = "yes" ]; then
  $KC -n "$NS" rollout restart deployment/ecommerce-customer deployment/ecommerce-seller >/dev/null
fi

for d in ecommerce-customer ecommerce-seller; do
  if ! $KC -n "$NS" rollout status "deployment/$d" --timeout=180s; then
    echo "deploy: rollout of $d failed - diagnostics follow" >&2
    $KC -n "$NS" get pods -o wide >&2 || true
    $KC -n "$NS" describe "deployment/$d" >&2 || true
    $KC -n "$NS" logs -l app.kubernetes.io/name=ecommerce-frontend --tail=50 --all-containers >&2 || true
    exit 1
  fi
done

# Smoke test each Service through a temporary port-forward (works without an ingress controller)
PF=""
trap 'for p in $PF; do kill "$p" 2>/dev/null || true; done; rm -f "${TMP:-}"' EXIT
$KC -n "$NS" port-forward svc/ecommerce-customer 18080:80 >/dev/null 2>&1 & PF="$PF $!"
$KC -n "$NS" port-forward svc/ecommerce-seller   18081:80 >/dev/null 2>&1 & PF="$PF $!"
sleep 3
curl -fsS http://127.0.0.1:18080/healthz >/dev/null && echo "deploy: customer /healthz OK"
curl -fsS http://127.0.0.1:18081/healthz >/dev/null && echo "deploy: seller   /healthz OK"
curl -fsS http://127.0.0.1:18080/assets/config.json
curl -fsS -o /dev/null -w "deploy: GET / -> HTTP %{http_code}\n" http://127.0.0.1:18080/

if $KC -n ingress-nginx get pods -l app.kubernetes.io/component=controller --no-headers 2>/dev/null | grep -q Running; then
  IP=$(minikube ip -p "$PROFILE")
  for p in / /products /seller-signup /healthz; do
    curl -s -o /dev/null -w "deploy: ingress http://$IP$p -> HTTP %{http_code}\n" "http://$IP$p" || true
  done
else
  echo "deploy: no ingress controller running - enable it with:  minikube addons enable ingress -p $PROFILE"
fi

echo "deploy: done."
