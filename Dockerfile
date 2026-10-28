FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
RUN npm ci

COPY . .
RUN npm run build --workspace=client

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev && mkdir -p /app/uploads && chown -R node:node /app

COPY --chown=node:node server ./server
COPY --chown=node:node --from=build /app/client/dist ./client/dist

USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
