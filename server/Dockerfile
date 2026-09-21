FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY src/lib/demo-allowlist.json ./src/lib/demo-allowlist.json
COPY image/demo ./image/demo
EXPOSE 4000
CMD ["node", "server/index.mjs"]
