# broadcast-box upstream + viewer-identity.patch: o `/api/status` passa a
# trazer o nick de quem assiste (query `?viewer=` no POST do WHEP).
# Patch aditivo — nada do upstream é alterado, só estendido.
FROM alpine/git AS src
ARG BROADCAST_BOX_REF=9f43de20e802ee8acc826c3999e021e736dd2a89
RUN git clone --depth 1 https://github.com/Glimesh/broadcast-box /src \
 && git -C /src fetch --depth 1 origin ${BROADCAST_BOX_REF} \
 && git -C /src checkout FETCH_HEAD
COPY viewer-identity.patch /tmp/
RUN git -C /src apply /tmp/viewer-identity.patch

FROM node:alpine AS web
COPY --from=src /src /src
WORKDIR /src/web
RUN npm install && npm run build

FROM golang:1.26-alpine AS go
ENV GOPROXY=direct GOSUMDB=off
RUN apk add git
COPY --from=src /src /src
WORKDIR /src
RUN go build

FROM golang:1.26-alpine
COPY --from=web /src/web/build /broadcast-box/web/build
COPY --from=go /src/broadcast-box /broadcast-box/broadcast-box
COPY --from=src /src/.env.production /broadcast-box/.env.production
ENV APP_ENV=production
WORKDIR /broadcast-box
ENTRYPOINT ["/broadcast-box/broadcast-box"]
