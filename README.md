# E-Commerce Angular

Frontend-only Angular 17 single-page app for a small e-commerce store with two roles:

- **Customers**: browse products, search, cart, checkout, order history
- **Sellers (admin)**: add, update and delete their products

It talks to a separate REST backend (`auth/*`, `users/*`, `products/*`, `carts/*`, `orders/*`). JWTs are kept in the browser's `localStorage`.

## Prerequisites

- Node.js 18.13+ (20 LTS recommended) and npm
- Docker 24+ (only for the container image)

## npm commands

| Command | What it does |
| --- | --- |
| `npm ci` | Clean install of the exact versions in `package-lock.json` |
| `npm install` | Install dependencies (updates the lockfile if needed) |
| `npm start` | Dev server (`ng serve`) at http://localhost:4200 with live reload |
| `npm run build` | Production build into `dist/client/browser` |
| `npm run watch` | Development build that rebuilds on every change |
| `npm test` | Unit tests via Karma/Jasmine (needs Chrome) |
| `npx ng test --watch=false --browsers=ChromeHeadless` | Single headless test run (CI) |
| `npx ng generate component <name>` | Scaffold a component (NgModule style, `standalone: false`) |

> Note: the production build currently fails on `anyComponentStyle` budget errors caused by inlined Google Fonts `@import`s. Set `"optimization": { "fonts": { "inline": false } }` in the `production` configuration of `angular.json`, or build through Docker, which applies this automatically.

## Backend URL

The API base URL is currently hard-coded as `url` in four services (`src/app/services/{shop,products,customer-signup,seller-signup}.service.ts`): `https://e-commerce-backend-f8v8.onrender.com/`. To point at another backend, change it there.

The repo also contains `src/app/services/config.service.ts` and `src/assets/config.json`, which support loading the URL at startup. They are **not wired in yet** (it needs an `APP_INITIALIZER` in `app.module.ts` and the services reading `ConfigService.apiUrl`). Until that is done, the `API_URL` container variable below has no effect on the app.

## Docker

The `Dockerfile` has three stages, so the final image contains only static files served by nginx:

1. `deps`: `node:20-alpine`, runs `npm ci`
2. `build`: runs the Angular production build
3. `runtime`: `nginx-unprivileged:1.27-alpine`, runs as non-root on port 8080

No secrets are needed at build time. `.dockerignore` keeps `.git`, `node_modules`, `.env*` and keys out of the build context, and `docker/40-config.sh` can write `assets/config.json` from `API_URL` when the container starts (see "Backend URL" above).

```bash
# Build
docker build -t e-commerce-angular:latest .

# Run (API_URL only takes effect once the runtime config is wired in)
docker run --rm -p 8080:8080 -e API_URL=https://your-backend.example.com/ e-commerce-angular:latest

# Hardened run
docker run --rm -p 8080:8080 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp \
  -e API_URL=https://your-backend.example.com/ e-commerce-angular:latest
```

Open http://localhost:8080. Health check: `GET /healthz`.

Check the image size and layers with `docker images e-commerce-angular` and `docker history --no-trunc e-commerce-angular`.

## Project structure

```
src/app/
  customer/   shop, product-details, search, cart, checkout, order  (cart/checkout/orders guarded)
  seller/     products, product-add, product-update                  (guarded)
  signup/     customer-signup, seller-signup, 404 wildcard
  services/   shop, products, customer-signup, seller-signup, config
  guards/     customer-auth, seller-auth
  models/     dataTypes.ts
docker/       nginx.conf, 40-config.sh (runtime config generator)
```

## Deploy to Minikube

Manifests live in `k8s/` and are applied directly with `kubectl apply -f` (no kustomize):

| File | What it is |
| --- | --- |
| `namespace.yaml` | the `npci-ecommerce` namespace |
| `deployment.yaml` | two Deployments from the **same image**: `ecommerce-customer` (2 replicas) and `ecommerce-seller` (1 replica) |
| `service.yaml` | ClusterIP Services for both, plus `ecommerce-backend` (ExternalName to the Render backend) |
| `ingress.yaml` | **path-based routing** (below) |
| `deploy.sh` | loads the image, creates the Secret, applies the files, waits for the rollout, smoke-tests |
| `rbac/` | the two roles (below) |

### Path-based routing

Derived from the Angular route table (`src/app/*/*-routing.module.ts`) and the REST calls in `src/app/services/`:

| URL path | Goes to | Why |
| --- | --- | --- |
| `/api/**` | `ecommerce-backend` (Render), `/api` prefix stripped | all REST calls (`auth`, `users`, `products`, `carts`, `orders`) become same-origin, no CORS, backend host not exposed to the browser |
| `/products`, `/products/upload`, `/products/update/:id` | `ecommerce-seller` | seller console |
| `/seller-signup` | `ecommerce-seller` | seller registration / login |
| everything else: `/`, `/product-details/:id`, `/search/:q`, `/cart`, `/checkout`, `/orders`, `/customer-signup` | `ecommerce-customer` | storefront |

Both frontends run the same image (an Angular SPA serves every route), so the split buys independent scaling, rollbacks and access control for the seller area, not different code. `/api` needs the app's backend URL set to `/api/` (see Secret below). The Ingress needs a controller: `minikube addons enable ingress`, then browse to `http://$(minikube ip)/`.

### Config in a Secret, not in the image

The app's `assets/config.json` (the backend URL) comes from the Kubernetes Secret `ecommerce-frontend-secret`, mounted at `/usr/share/nginx/html/assets/config.json`. It is **not** in git or the image: `deploy.sh` creates it from the `API_URL` environment variable (a Jenkins credential in CI). `k8s/examples/secret.example.yaml` shows its shape. The pod will not start until the Secret exists. Kubernetes Secrets are only base64-encoded by default: restrict access with RBAC (see below) and enable encryption at rest on real clusters.

### Deploy

```bash
minikube start --driver=docker --cpus=2 --memory=2200
minikube addons enable ingress                    # needed for path routing
API_URL=/api/ sh k8s/deploy.sh npci-ecommerce-frontend:local
curl http://$(minikube ip)/healthz ; curl -I http://$(minikube ip)/products
```

From Jenkins: add a "Secret text" credential `ecommerce-api-url` (value `/api/`), then **Build with Parameters** with `DEPLOY_TO_MINIKUBE` ticked. The `jenkins` user needs its own Minikube (`sudo -u jenkins -H minikube start --driver=docker`). Roll back with `kubectl -n npci-ecommerce rollout undo deployment/ecommerce-customer`.

## Roles (RBAC)

Two roles, in `k8s/rbac/`. Apply with `sh k8s/rbac/apply.sh`, prove them with `sh k8s/rbac/verify.sh` (21 allow/deny checks).

| Role | Who | Access |
| --- | --- | --- |
| **Admin** (`admin-access.yaml`) | you: the Minikube client certificate identity `minikube-user` | `cluster-admin`: everything. Minikube already grants this through `system:masters`; the binding makes it explicit and auditable. |
| **AI agent** (`ai-agent.yaml`) | ServiceAccount `npci-ecommerce/ai-agent` | **Read** pods, logs, events, services, endpoints, deployments, replicasets, ingresses in `npci-ecommerce`, plus nodes/namespaces cluster-wide. **Write** only: patch deployments (rollout restart/undo, scale) and delete pods, in `npci-ecommerce` only. **No** access to Secrets, `exec`, RBAC, other namespaces, or creating/deleting Deployments. |

"Ask before proceeding" is enforced twice: the agent itself never changes anything without you typing `APPROVE <id>`, and RBAC limits what even an approved action can touch.

The agent runs with a short-lived token (default 8 h, no long-lived secret) in its own kubeconfig, outside the repo:

```bash
sh k8s/rbac/make-kubeconfig.sh                 # writes ~/.kube/ai-agent.kubeconfig (mode 600); re-run when it expires
```

## AI incident agent

`agent/` is a small Node.js CLI (no build step; Node >= 18.13) that investigates a failing deployment from real evidence and recommends a fix.

```bash
cd agent && npm install                         # only needed for --llm
node bin/ai-agent.js diagnose --kubeconfig ~/.kube/ai-agent.kubeconfig \
    --ci-status ../ci-status.json --url http://$(minikube ip)/healthz
node bin/ai-agent.js diagnose --kubeconfig ~/.kube/ai-agent.kubeconfig --apply   # walk through fixes, asking first
```

**Evidence it reads (read-only):** pods, deployments, replicasets, services, endpoints, ingresses, events and pod logs (secrets/tokens redacted) from the cluster; the Jenkins `ci-status.json` and the Trivy report; HTTP health-check results; the ingress controller's pods and logs. Web access logs are structured JSON (`docker/nginx.conf`) and parsed for 5xx.

**Output.** Each finding states its severity, a **status** (`CONFIRMED` = only directly observed facts; `LIKELY` = observed facts plus listed assumptions; `HYPOTHESIS` = weak evidence), the **evidence ids** it rests on, its **assumptions** (or "none needed"), and the proposed fix. Facts the agent could not observe are listed under *NOT OBSERVED*. It never fills a gap with a guess.

**Human approval.** The agent can only run four catalogued actions (`rollout-restart`, `rollout-undo`, `scale`, `delete-pod`), built from validated parameters into a command without a shell. With `--apply` it shows each one with its evidence, exact command, risk, a server-side dry-run result and a rollback note, checks RBAC, then waits for you to type `APPROVE <id>` in an interactive terminal. Anything else skips it. There is **no** auto-approve flag, and without a terminal nothing runs. Everything is appended to `~/.ai-agent/audit.log`. Manual steps outside its permissions (creating the Secret, loading an image, enabling the ingress addon) are listed as such.

**Optional Claude summary (`--llm`).** Uses `claude-opus-5-5` (override with `AGENT_MODEL`) through the official SDK with structured output and server-side fallbacks. It needs `ANTHROPIC_API_KEY` or `ant auth login`. Claude only summarises and orders findings the rules already produced: its answer is validated, and any evidence id or action it invents is dropped and reported. Evidence is redacted before it is sent. Without `--llm` nothing leaves your machine.

Tests: `cd agent && npm test` (58 tests: rules, approval gate, command validation, read-only collection, redaction).
