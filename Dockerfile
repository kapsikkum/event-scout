# Node 24 for `node:sqlite`, which is what the database layer uses — there is
# no native module to build here, and it should stay that way.
FROM docker.io/library/node:24-slim AS build
WORKDIR /app

# Manifests first, so a change to source does not re-resolve the dependency
# tree. Every workspace's package.json has to be present for `npm ci` to plan
# the install.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev


FROM docker.io/library/node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies: the server spawns nothing in this configuration, but
# PID 1 without a reaper is a trap worth staying out of.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# db.ts resolves its directory relative to the compiled server, so this is
# where the database lands. Mount it.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3001
ENV API_PORT=3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
