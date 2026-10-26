# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f services/auth/Dockerfile -t food/auth-service .

# ---- build: compile TypeScript for this service and the shared package ----
FROM node:24-alpine AS build
WORKDIR /app
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/common/package.json packages/common/
COPY services/auth/package.json services/auth/
RUN npm ci --workspace=@food/common --workspace=@food/auth-service --include-workspace-root --ignore-scripts
COPY packages/common packages/common
COPY services/auth services/auth
RUN npm run build -w @food/common && npm run build -w @food/auth-service

# ---- runtime: production dependencies + compiled output only ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/auth/package.json services/auth/
RUN npm ci --workspace=@food/common --workspace=@food/auth-service --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/common/dist packages/common/dist
COPY --from=build /app/services/auth/dist services/auth/dist
USER node
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4001/health > /dev/null || exit 1
CMD ["node", "services/auth/dist/server.js"]
