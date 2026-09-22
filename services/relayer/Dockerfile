# services/relayer/Dockerfile
#
# Build context = repo root (Railway: service root directory "/",
# RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile). The relayer imports
# tests/er/lib/{env,program,hashes,...}.ts directly at runtime via tsx (no
# build step, see CMD below) instead of duplicating that library, so this
# image needs tests/er/lib's own package.json + node_modules installed
# alongside services/relayer's own.
#
# app/src/idl/dexxer_core.json is the only IDL asset committed to git
# (target/idl/ is fully gitignored, `anchor build` output; CI's "IDL copy in
# app matches build" step keeps the two in sync) — DEXXER_IDL_DIR points
# tests/er/lib/program.ts at this copy instead of its default `target/idl`.
# mock_oracle.json is NOT copied: it isn't committed, and the relayer runs
# exclusively against DEXXER_NET=devnet's real Pricing Oracle, never the
# local mock oracle — program.ts tolerates mock_oracle.json's absence (see
# its `loadIdlOptional` comment).

FROM node:24-alpine

WORKDIR /app

# tests/er/lib — installed first (own package.json/lock), then just the lib/
# directory copied in (not the whole tests/er tree: scripts, devnet/, etc.
# are dev-only harnesses this service never runs).
COPY tests/er/package.json tests/er/package-lock.json tests/er/
RUN npm --prefix tests/er ci --omit=dev
COPY tests/er/lib tests/er/lib

# services/relayer itself.
COPY services/relayer/package.json services/relayer/package-lock.json* services/relayer/
RUN npm --prefix services/relayer ci --omit=dev
COPY services/relayer services/relayer

# The one committed IDL asset (see header comment).
COPY app/src/idl/dexxer_core.json app/src/idl/dexxer_core.json

ENV DEXXER_IDL_DIR=/app/app/src/idl
ENV NODE_ENV=production

WORKDIR /app/services/relayer

EXPOSE 8080

CMD ["node", "--import", "tsx", "src/index.ts"]
