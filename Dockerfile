FROM node:22.14.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm --filter @yours/api... build

FROM node:22.14.0-bookworm-slim
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "services/api/dist/server.js"]
