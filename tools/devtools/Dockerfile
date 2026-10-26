# syntax=docker/dockerfile:1
# Development-only console (Swagger UI + testing console + observability). Never deployed to production.
# Build from the repository root:  docker build -f tools/devtools/Dockerfile -t food/devtools .
FROM node:24-alpine AS assets
WORKDIR /assets
RUN npm pack swagger-ui-dist@5.17.14 --silent && tar -xzf swagger-ui-dist-5.17.14.tgz

FROM node:24-alpine
ENV NODE_ENV=development
WORKDIR /app
COPY --from=assets /assets/package /app/swagger-ui
COPY tools/devtools/server.mjs ./
COPY tools/devtools/public ./public
COPY docs/openapi.json ./openapi.json
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/healthz > /dev/null || exit 1
CMD ["node", "server.mjs"]
