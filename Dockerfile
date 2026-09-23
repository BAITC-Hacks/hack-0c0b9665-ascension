FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 COMPLAINTS_FILE=/app/var/complaints.json

# The application has no third-party runtime npm dependencies.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
COPY --chown=node:node public ./public
RUN mkdir -p /app/var && chown node:node /app/var

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
