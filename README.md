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
