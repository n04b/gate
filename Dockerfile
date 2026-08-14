# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    GATE_CONFIG=/app/config/gate.yaml \
    GATE_BOOTSTRAP=true

# su-exec drops privileges in the entrypoint after mounted state is made
# writable; nothing else in the image needs root.
RUN apk add --no-cache su-exec

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# `docker exec gate gate token create ...` — run as whoever owns /data so the
# append-only token log never ends up with mixed ownership.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'if [ "$(id -u)" = "0" ] && [ -d /data ]; then' \
      '  exec su-exec "$(stat -c %u:%g /data)" node /app/dist/cli.js "$@"' \
      'fi' \
      'exec node /app/dist/cli.js "$@"' > /usr/local/bin/gate \
    && chmod +x /usr/local/bin/gate /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data /app/config \
    && chown -R node:node /data /app/config

# The token log and the generated JWT keys live in a volume, not in the image.
VOLUME ["/data"]

# No key material is baked into the image. GATE_BOOTSTRAP makes the container
# write a default config and generate the key pair on first start, at runtime.
#
# The entrypoint starts as root only to fix ownership of bind-mounted state and
# then execs Gate as PUID:PGID (1000:1000 by default) — the server itself never
# runs as root. Set `user:` in compose to skip that and run unprivileged from
# the very first instruction.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
