# Jabuti as one container: the server runs its TypeScript directly (Node type
# stripping) and serves the built UI. State lives in the /data volume.

FROM node:26-slim AS base
RUN npm install -g pnpm@11.10.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/runner/package.json packages/runner/
COPY packages/mcp-serper/package.json packages/mcp-serper/
COPY packages/mcp-gsc/package.json packages/mcp-gsc/
COPY packages/mcp-pagespeed/package.json packages/mcp-pagespeed/
COPY packages/mcp-dataforseo/package.json packages/mcp-dataforseo/
COPY packages/mcp-images/package.json packages/mcp-images/
COPY packages/mcp-wikipedia/package.json packages/mcp-wikipedia/
COPY contract/package.json contract/

# Scripts are skipped: the only one is lefthook's git hook installer.
FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @jabuti/ui build

# Development with hot reload: docker compose -f compose.dev.yml up --watch
FROM build AS dev
ENV JABUTI_DATA_DIR=/data
EXPOSE 5173
CMD ["pnpm", "dev:docker"]

# The shell runner (C3): agents' commands, with Python for analysis. No Jabuti
# secrets ever reach this image or its container.
FROM node:26-slim AS runner
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    git openssh-client curl ca-certificates jq unzip ripgrep sqlite3 \
 && rm -rf /var/lib/apt/lists/*
# web_read and page_structure (C20): page.py and its libraries, outside every
# agent's workspace, readable by all and writable by none of them.
COPY packages/runner/page /opt/jabuti/page
RUN python3 -m venv /opt/jabuti/venv \
 && /opt/jabuti/venv/bin/pip install --no-cache-dir -r /opt/jabuti/page/requirements.txt
# The agents' own python3 reads attached PDF, Word and Excel files with these.
COPY packages/runner/agent-requirements.txt /opt/jabuti/agent-requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r /opt/jabuti/agent-requirements.txt
WORKDIR /runner
COPY packages/runner/src src
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.ts"]

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @jabuti/server... --filter @jabuti/mcp-serper --filter @jabuti/mcp-gsc --filter @jabuti/mcp-pagespeed --filter @jabuti/mcp-dataforseo --filter @jabuti/mcp-images --filter @jabuti/mcp-wikipedia

FROM node:26-slim
# Set by the release workflow; a build without them is "dev" (Settings → Version).
ARG JABUTI_VERSION=dev
ARG JABUTI_COMMIT=
ARG JABUTI_REPOSITORY=guilhermemauro/jabuti
ENV JABUTI_VERSION=$JABUTI_VERSION \
    JABUTI_COMMIT=$JABUTI_COMMIT \
    JABUTI_REPOSITORY=$JABUTI_REPOSITORY
ENV NODE_ENV=production \
    JABUTI_HOST=0.0.0.0 \
    JABUTI_PORT=4317 \
    JABUTI_DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server
COPY packages/mcp-serper packages/mcp-serper
COPY packages/mcp-gsc packages/mcp-gsc
COPY packages/mcp-pagespeed packages/mcp-pagespeed
COPY packages/mcp-dataforseo packages/mcp-dataforseo
COPY packages/mcp-images packages/mcp-images
COPY packages/mcp-wikipedia packages/mcp-wikipedia
COPY agents agents
COPY skills skills
COPY --from=build /app/packages/ui/dist packages/ui/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:4317/api/session').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/src/index.ts"]
