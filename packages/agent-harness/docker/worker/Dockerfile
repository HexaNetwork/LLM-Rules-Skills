# Worker image: @cursor/sdk and project tools live here. The host owns workflow and state.
FROM node:22-bookworm-slim

# Temurin JDK 25: Gradle toolchains in target projects may request a recent JDK.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git wget gpg \
  && install -d /etc/apt/keyrings \
  && wget -qO /etc/apt/keyrings/adoptium.asc https://packages.adoptium.net/artifactory/api/gpg/key/public \
  && echo "deb [signed-by=/etc/apt/keyrings/adoptium.asc] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends temurin-25-jdk \
  && ln -s "$(ls -d /usr/lib/jvm/temurin-25-jdk-* | head -n1)" /opt/jdk-25 \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/opt/jdk-25
ENV PATH="/opt/jdk-25/bin:${PATH}"

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
