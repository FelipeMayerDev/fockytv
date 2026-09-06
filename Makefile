# Tudo roda em container: nenhum toolchain Node local é necessário.
# A janela do Electron em si abre no seu desktop (GUI não faz sentido em container).

# Lido do package.json sem toolchain local.
VERSION = $(shell sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)

IN_DOCKER = docker run --rm -v "$(CURDIR)":/project -w /project \
            -u $(shell id -u):$(shell id -g) -e HOME=/project/.cache

.PHONY: help run linux windows release audio-helper
.DEFAULT_GOAL := help

help:
	@echo "make run      abre o client"
	@echo "make linux    empacota o AppImage  -> dist/"
	@echo "make windows  empacota o instalador -> dist/"
	@echo "make release  publica os dois nas Releases do GitHub (precisa de GH_TOKEN)"

# Captura de áudio por aplicativo (Windows): helper WASAPI compilado com
# mingw dentro do docker — mesmo esquema dos targets de empacotamento.
audio-helper: electron/audio-helper/capture.cpp
	$(IN_DOCKER) debian:bookworm bash -c \
	  "apt-get update -qq && apt-get install -y -qq g++-mingw-w64-x86-64 >/dev/null && \
	   x86_64-w64-mingw32-g++ -std=c++17 -O2 -static \
	     -o electron/audio-helper/audio-helper.exe electron/audio-helper/capture.cpp \
	     -lole32 -lpsapi"

# Dependências: refeitas só quando o package.json muda.
node_modules: package.json
	$(IN_DOCKER) node:22 npm install
	@touch node_modules

run: node_modules
	./node_modules/.bin/electron .

linux: node_modules
	$(IN_DOCKER) electronuserland/builder:latest npx electron-builder --linux AppImage
	@cp config.json dist/
	@echo "pronto: $$(ls dist/*.AppImage) (+ config.json ao lado, editável)"

windows: node_modules audio-helper
	$(IN_DOCKER) electronuserland/builder:wine npx electron-builder --win nsis
	@cp config.json dist/
	@echo "pronto: $$(ls dist/*.exe) (+ config.json ao lado, editável)"

# O auto-update lê as Releases do GitHub: sem publicar, nada é atualizado.
# Suba a versão no package.json antes; o electron-builder cria a tag vX.Y.Z.
release: node_modules audio-helper
	@test -n "$$GH_TOKEN" || { echo "defina GH_TOKEN (precisa de escopo 'repo')"; exit 1; }
	$(IN_DOCKER) -e GH_TOKEN electronuserland/builder:wine \
	  npx electron-builder --linux AppImage --win nsis --publish always
	@# O electron-builder cria a release como draft, e o updater nao le draft:
	@# sem este passo o update falha em silencio, sem erro nenhum.
	@# As notas sao os assuntos dos commits desde a tag anterior: e delas que
	@# sai o toast de "o que mudou" no primeiro boot depois de atualizar.
	git fetch --tags -q
	prev=$$(git describe --tags --abbrev=0 --exclude=v$(VERSION) 2>/dev/null); \
	  git log --pretty='- %s' $${prev:+$$prev..}HEAD \
	  | gh release edit v$(VERSION) --draft=false --notes-file -
	@echo "release v$(VERSION) publicada e visivel pro updater"
