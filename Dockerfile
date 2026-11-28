# Matchday Live: one small Node service. Data lives in DATA_DIR, so mount a
# volume there (Render disk, Railway volume, Fly volume) to keep it.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Runs as root on purpose: a host-mounted volume is owned by root, and the app
# has to be able to write db.json into it.
ENV PORT=3000 DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
