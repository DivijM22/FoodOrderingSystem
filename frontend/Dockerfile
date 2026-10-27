# syntax=docker/dockerfile:1
# Web frontend: static React build served by nginx. Build context = this directory (independent of the backend):
#   docker build -t food/frontend frontend
# The API gateway URL is runtime configuration (API_URL), so one image works in any environment: an absolute gateway
# URL (local default), or /api to use the same-origin proxy in docker/nginx.conf (cloud).

# ---- build: install exact dependencies and produce dist/ ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime: nginx serving static files, with an /api/ proxy to the gateway (no secrets) ----
FROM nginx:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/40-app-config.sh /docker-entrypoint.d/40-app-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-app-config.sh
ENV API_URL=http://localhost:8080
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz > /dev/null || exit 1
