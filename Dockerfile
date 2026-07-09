# gal_folio — runs anywhere that supports Docker (Railway, Fly.io, Render, a VPS…)
FROM node:22-alpine

WORKDIR /app

# No dependencies to install — the app uses only Node built-ins.
COPY package.json ./
COPY server.js ./
COPY public ./public

# Data (holdings, settings, history) is written here. Mount a PERSISTENT volume
# at /data so it survives restarts and redeploys.
ENV DATA_FILE=/data/data.json
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
