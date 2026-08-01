# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY . .
RUN test -n "$NEXT_PUBLIC_API_URL" \
  && npm run app:check \
  && npm run server:check \
  && npm run build

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

FROM production-dependencies AS web
ENV PORT=3000
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "node_modules/vinext/dist/cli.js", "start"]

FROM production-dependencies AS api
ENV PORT=4000
COPY --chown=node:node server ./server
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "server/index.ts"]
