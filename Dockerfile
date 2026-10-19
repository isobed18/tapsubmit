FROM node:24.13.0-bookworm-slim
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY web ./web
COPY config ./config
COPY demo/lib ./demo/lib
COPY demo/public/search-engine.mjs demo/public/jobs.json ./demo/public/
# Shared job pool: public posting metadata exported by scripts/export_job_catalog.mjs --description-chars=0.
# Indexed into a read-only SQLite file inside the image, so the 500 MB volume is not used for it.
COPY public-pool/jobs-0001.jsonl.gz public-pool/manifest.json ./public-pool/
COPY scripts/build_public_pool_index.mjs ./scripts/build_public_pool_index.mjs
RUN node --no-warnings scripts/build_public_pool_index.mjs
ENV NODE_ENV=production APPLYBURST_DATA=/data APPLYBURST_MODEL_CACHE=/data/models APPLYBURST_PRELOAD_MODEL=1 APPLYBURST_INFERENCE_THREADS=1 OMP_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false
CMD ["node", "--max-old-space-size=768", "web/discovery-server.mjs"]
