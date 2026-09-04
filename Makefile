# Tudo roda em container: nenhum toolchain Node local é necessário.
# A janela do Electron em si abre no seu desktop (GUI não faz sentido em container).

IN_DOCKER = docker run --rm -v "$(CURDIR)":/project -w /project \
            -u $(shell id -u):$(shell id -g) -e HOME=/project/.cache

.PHONY: help run linux windows release
.DEFAULT_GOAL := help

help:
	@echo "make run      abre o client"
	@echo "make linux    empacota o AppImage  -> dist/"
	@echo "make windows  empacota o instalador -> dist/"
	@echo "make release  publica os dois nas Releases do GitHub (precisa de GH_TOKEN)"

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

windows: node_modules
	$(IN_DOCKER) electronuserland/builder:wine npx electron-builder --win nsis
	@cp config.json dist/
	@echo "pronto: $$(ls dist/*.exe) (+ config.json ao lado, editável)"

# O auto-update lê as Releases do GitHub: sem publicar, nada é atualizado.
# Suba a versão no package.json antes; o electron-builder cria a tag vX.Y.Z.
release: node_modules
	@test -n "$$GH_TOKEN" || { echo "defina GH_TOKEN (precisa de escopo 'repo')"; exit 1; }
	$(IN_DOCKER) -e GH_TOKEN electronuserland/builder:wine \
	  npx electron-builder --linux AppImage --win nsis --publish always
