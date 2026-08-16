# Worker image: @cursor/sdk and project tools live here. The host owns workflow and state.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-harness
COPY package.json ./
RUN npm install --omit=dev
COPY dist ./dist

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin harness \
  && mkdir -p /workspace \
  && chown 10001:10001 /workspace

USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
