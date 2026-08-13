# Maintained agent-harness worker image (ADR 0015).
# Built from the package checkout after `npm run build` (needs dist/ + package.json).
# Binary path must match WORKER_IMAGE_BINARY_PATH in execution-image-generator.
FROM node:22-bookworm-slim

WORKDIR /opt/agent-harness

COPY package.json ./
RUN npm install --omit=dev

COPY dist ./dist

RUN printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-harness/dist/cli.js worker "$@"' \
  > /opt/agent-harness/worker \
  && chmod 0755 /opt/agent-harness/worker \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin harness || true

USER 10001:10001
ENTRYPOINT ["/opt/agent-harness/worker"]
