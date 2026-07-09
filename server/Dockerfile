FROM node:20-alpine

WORKDIR /app

# Copy the whole repo so server.js can reach ../worker/src/app.html and ../shared/sync-script.js
COPY . /repo
WORKDIR /repo/server

RUN npm install --omit=dev

ENV PORT=8787
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8787

CMD ["node", "server.js"]
