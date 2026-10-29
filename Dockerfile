# syntax=docker/dockerfile:1.7

# ---------- Stage 1: install dependencies ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# ---------- Stage 2: build the Angular app ----------
FROM deps AS build
WORKDIR /app
COPY . .
# The production build fails on style budgets caused by inlined Google Fonts.
# Disable font inlining for this build only (angular.json in the repo stays untouched).
RUN node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('angular.json','utf8'));\
j.projects.client.architect.build.configurations.production.optimization={scripts:true,styles:{minify:true,inlineCritical:true},fonts:{inline:false}};\
fs.writeFileSync('angular.json',JSON.stringify(j,null,2))"
RUN npm run build -- --configuration production

# ---------- Stage 3: minimal, non-root runtime ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Only the compiled static files are copied: no Node, npm, source code or .git in the final image.
COPY --from=build /app/dist/client/browser /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/40-config.sh /docker-entrypoint.d/40-config.sh

# Backend URL is injected at container start (never baked into the image).
ENV API_URL=""

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
# Runs as the unprivileged user (uid 101) defined by the base image.
