# One-shot job: provisions per-service RabbitMQ users, permissions and exchanges, then exits.
FROM node:24-alpine
WORKDIR /app
COPY setup.mjs .
USER node
CMD ["node", "setup.mjs"]
