FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/var /app/backups && chown -R node:node /app/var /app/backups
USER node
ENV HOST=0.0.0.0 PORT=3000 DESK_DB_PATH=/app/var/desk.sqlite COOKIE_SECURE=true
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
