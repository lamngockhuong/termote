# Termote Makefile
# Usage: make <target>

.PHONY: help build build-pwa build-api test test-go test-cli test-install test-entrypoints test-herdr-plugin start container-up container-down uninstall health clean release release-dry fmt fmt-check

# Default target
help:
	@echo "Termote - Terminal Remote Control"
	@echo ""
	@echo "Build:"
	@echo "  make build          Build PWA and server"
	@echo "  make build-pwa      Build PWA only"
	@echo "  make build-api      Build server (embeds the PWA)"
	@echo ""
	@echo "Run:"
	@echo "  make start          Start the server as a service (native)"
	@echo "  make container-up   Run the server in a container (docker/podman)"
	@echo ""
	@echo "Test:"
	@echo "  make test              Run all tests"
	@echo "  make test-go           Test server/ (server + CLI) with go test"
	@echo "  make test-cli          Test the termote.sh shim"
	@echo "  make test-install      Test the install.sh online installer"
	@echo "  make test-entrypoints  Test entrypoint scripts"
	@echo "  make test-herdr-plugin Test the Herdr plugin launcher"
	@echo ""
	@echo "Release:"
	@echo "  make release        Tag and push new release (VERSION=x.y.z)"
	@echo "  make release-dry    Show what would be released"
	@echo ""
	@echo "Format:"
	@echo "  make fmt            Format markdown/mdx files (dprint)"
	@echo "  make fmt-check      Check markdown/mdx formatting"
	@echo ""
	@echo "Other:"
	@echo "  make health         Check service health"
	@echo "  make clean          Stop and remove containers"
	@echo "  make uninstall      Uninstall all"

# Build targets
build: build-pwa build-api

build-pwa:
	@echo "Building PWA..."
	pnpm install --frozen-lockfile --filter termote...
	pnpm --filter termote build

# The PWA is embedded in the binary (server/webui); the copy replaces the old
# build so stale hashed assets are not embedded again.
build-api: build-pwa
	@echo "Building server..."
	find server/webui/dist -mindepth 1 ! -name .gitkeep -delete
	cp -R pwa/dist/. server/webui/dist/
	cd server && CGO_ENABLED=0 go build -ldflags="-s -w" -o termote .

# Run targets (through the checkout shim)
start:
	./scripts/termote.sh start

container-up:
	./scripts/termote.sh container up

container-down:
	./scripts/termote.sh container down

# Test targets
test: test-go test-cli test-install test-entrypoints test-herdr-plugin
	@echo ""
	@echo "All tests completed!"

test-go:
	cd server && go test ./...

test-cli:
	@chmod +x tests/test-termote.sh
	@./tests/test-termote.sh

test-install:
	@chmod +x tests/test-install.sh
	@./tests/test-install.sh

test-entrypoints:
	@chmod +x tests/test-entrypoints.sh
	@./tests/test-entrypoints.sh

test-herdr-plugin:
	@chmod +x tests/test-herdr-plugin.sh
	@./tests/test-herdr-plugin.sh

# Format targets (dprint)
fmt:
	npx dprint fmt

fmt-check:
	npx dprint check

# Health check
health:
	./scripts/termote.sh health

# Container runtime detection
CONTAINER_RT := $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)

# Cleanup
clean:
	$(CONTAINER_RT) compose down 2>/dev/null || true
	$(CONTAINER_RT) stop termote 2>/dev/null || true
	$(CONTAINER_RT) rm termote 2>/dev/null || true
	rm -f docker-compose.override.yml

uninstall:
	./scripts/termote.sh uninstall

# Release targets
release-dry:
	@echo "=== Current version ===" && \
	grep '"version"' pwa/package.json && \
	echo "" && \
	echo "=== Recent tags ===" && \
	(git tag --sort=-version:refname | head -5 || echo "(no tags)") && \
	echo "" && \
	echo "=== Unreleased commits ===" && \
	git --no-pager log $$(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~10")..HEAD --oneline

release:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release VERSION=1.2.3"; \
		exit 1; \
	fi
	@echo "Creating release v$(VERSION)..."
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
	@echo ""
	@echo "Release v$(VERSION) triggered!"
	@echo "Monitor: https://github.com/lamngockhuong/termote/actions"
