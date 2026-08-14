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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `docker exec gate gate token create ...`
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/gate \
    && chmod +x /usr/local/bin/gate \
    && mkdir -p /data /app/config \
    && chown -R node:node /data /app/config

# The token log and the generated JWT keys live in a volume, not in the image.
VOLUME ["/data"]

# No key material is baked into the image. GATE_BOOTSTRAP makes the container
# write a default config and generate the key pair on first start, at runtime.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
