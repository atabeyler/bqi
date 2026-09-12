# Node 22 + Python 3.11 in one image: the server itself is plain Node/Express
# (run via tsx), but it shells out to server/quantum/*.py for Qiskit-backed
# analysis, so both runtimes have to be present at runtime, not just at build.
#
# Only server/ and client/ are ever installed here -- never the repo root
# package.json, which is the Electron desktop app's manifest and pulls in
# better-sqlite3 (a native addon) and electron itself. Installing that at the
# image root broke Northflank's buildpack auto-detection (which installs
# from whatever package.json it finds at the repo root, and tried to compile
# better-sqlite3's native addon there).
FROM node:22-bookworm-slim

# python3 on bookworm is 3.11 -- picked because it's the last release with
# prebuilt wheels for qiskit's symengine dependency (3.12+ falls back to a
# from-source build that fails, since the SymEngine C++ library isn't
# installed).
#
# build-essential (make/g++/gcc) is needed only for `npm ci` below to compile
# bcrypt's native addon (replaced bcryptjs -- the pure-JS fallback -- because
# bcryptjs's cost-12 hashing on this deployment's small compute plan was
# costing several seconds per login). It's purged again right after npm ci
# so it never ships in the final image (smaller image, smaller attack
# surface); the already-compiled bcrypt .node binary doesn't need it at
# runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json server/
RUN npm ci --prefix server \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY client/package.json client/package-lock.json client/
RUN npm ci --prefix client

COPY server/quantum/requirements.txt server/quantum/requirements.txt
# --ignore-installed: the base image ships a system PyJWT (via apt/
# dist-packages) that pip can't uninstall (no RECORD metadata, "installed by
# debian"), which would otherwise abort the whole install before qiskit gets
# to install -- silently leaving quantum mode broken (falls back to AI-only
# estimates with no visible error).
RUN pip3 install --break-system-packages --ignore-installed -r server/quantum/requirements.txt

COPY server/ server/
COPY client/ client/
# The running server only ever serves the built client/dist static files
# (see index.js's express.static call) -- client/node_modules (including
# the devDependencies vite build itself needed, like vite proper) is never
# read at runtime, so the whole tree is dropped instead of just the vite
# cache dir, and server's own devDependencies (eslint, vitest, typescript,
# etc. -- tsx itself is a real dependency, needed to run src/index.js) are
# pruned the same way: smaller final image, smaller attack surface.
RUN npm run build --prefix client \
    && rm -rf client/node_modules \
    && npm prune --omit=dev --prefix server

# Runs as an unprivileged user rather than root -- the quantum subprocess
# (server/quantum/*.py) and any file-upload handling have no need for root,
# and running as root widens the blast radius of any RCE in either runtime.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 10000

# node's own http client instead of curl -- bookworm-slim doesn't ship curl
# and adding it just for this would be extra attack surface for one probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 10000) + '/api/platform/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "run", "start", "--prefix", "server"]
