# Maintained agent-harness worker image (ADRs 0016/0017).
# Built from the package checkout after `npm run build` (needs dist/ + package.json).
# `prepare-worker-image` builds or pulls this image and persists its content digest.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-harness

COPY package.json ./
RUN npm install --omit=dev

COPY dist ./dist

RUN printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-harness/dist/cli.js worker "$@"' \
  > /opt/agent-harness/worker \
  && printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-harness/dist/cli.js "$@"' \
  > /opt/agent-harness/cli \
  && printf '%s\n' '#!/bin/sh' 'exec node /opt/agent-harness/dist/cli.js sandbox-isolation-self-check "$@"' \
  > /opt/agent-harness/sandbox-isolation-self-check \
  && chmod 0755 /opt/agent-harness/worker /opt/agent-harness/cli /opt/agent-harness/sandbox-isolation-self-check \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin harness || true

# A fresh named volume inherits the image directory's ownership. Without this the
# volume is created root-owned and the non-root worker cannot write /workspace.
RUN mkdir -p /workspace && chown 10001:10001 /workspace && chmod 0755 /workspace

USER 10001:10001
ENTRYPOINT ["/opt/agent-harness/worker"]
