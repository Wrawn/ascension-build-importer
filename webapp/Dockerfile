# Zero-dependency Node app — no build step, no npm install needed.
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=8787
EXPOSE 8787

# Basic container healthcheck against the app's /healthz route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
