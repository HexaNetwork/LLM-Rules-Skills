FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 harness \
 && mkdir -p /opt/harness /workspace \
 && chown -R harness:harness /opt/harness /workspace
WORKDIR /opt/harness
COPY package.json ./package.json
RUN npm install --omit=dev --ignore-scripts \
 && npm cache clean --force
COPY dist/worker.js ./worker.js
USER harness
WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
