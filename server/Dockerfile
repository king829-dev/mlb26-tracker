FROM node:22-alpine

WORKDIR /app

# Copy the whole repo so server.js can reach ../worker/src/app.html and ../shared/sync-script.js
COPY . /repo
WORKDIR /repo/server

RUN apk add --no-cache openssl && npm install --omit=dev && chmod +x entrypoint.sh

ENV PORT=8787
ENV HTTPS_PORT=8443
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8787
EXPOSE 8443

CMD ["./entrypoint.sh"]
