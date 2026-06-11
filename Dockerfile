# TalkBack — zero runtime dependencies, so there is no install step.
# The image is the Node 20 Alpine base plus this repo's source. That's it.

FROM node:20-alpine

WORKDIR /app

# No package install: package.json declares zero dependencies and
# zero devDependencies. Copy source only.
COPY . .

# Drop root. The server needs no privileged ports (default 8787)
# and writes nothing unless IDEMPOTENCY_FILE points somewhere writable.
USER node

EXPOSE 8787

CMD ["node", "server.js"]
