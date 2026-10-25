FROM node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS base
WORKDIR /app

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN node node_modules/prisma/build/index.js generate && npm run build

FROM build AS development
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/hoopyTL/TixGo-Backend" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=development
COPY tests ./tests
COPY scripts ./scripts
CMD ["npm", "run", "dev"]

FROM build AS migration
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/hoopyTL/TixGo-Backend" \
      org.opencontainers.image.revision="${VCS_REF}"
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

FROM base AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/hoopyTL/TixGo-Backend" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+Number(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
