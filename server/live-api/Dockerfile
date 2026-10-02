# live-api: binário estático sem CGO — imagem scratch mínima (sinalização é
# leve: só HTTP pro mediamtx/fixed-live + estáticos da ui/)
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /live-api .

FROM scratch
COPY --from=build /live-api /live-api
ENTRYPOINT ["/live-api"]
