# Termote Makefile
# Usage: make <target>

.PHONY: help build test test-cli test-get test-entrypoints install-container install-native clean release release-dry fmt fmt-check

# Default target
help:
	@echo "Termote - Terminal Remote Control"
	@echo ""
	@echo "Build:"
	@echo "  make build          Build PWA and tmux-api"
	@echo "  make build-pwa      Build PWA only"
	@echo "  make build-api      Build tmux-api only"
	@echo ""
	@echo "Install:"
	@echo "  make install-container  Install container mode (docker/podman)"
	@echo "  make install-native     Install native mode (host tools)"
	@echo ""
	@echo "Test:"
	@echo "  make test              Run all tests"
	@echo "  make test-cli          Test termote.sh CLI"
	@echo "  make test-get          Test get.sh online installer"
	@echo "  make test-entrypoints  Test entrypoint scripts"
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
	cd pwa && pnpm install --frozen-lockfile && pnpm build

build-api:
	@echo "Building tmux-api..."
	cd tmux-api && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .

# Install targets (uses unified CLI)
install-container:
	./scripts/termote.sh install container

install-container-lan:
	./scripts/termote.sh install container --lan

install-native:
	./scripts/termote.sh install native

install-native-lan:
	./scripts/termote.sh install native --lan

# Test targets
test: test-cli test-get test-entrypoints
	@echo ""
	@echo "All tests completed!"

test-cli:
	@chmod +x tests/test-termote.sh
	@./tests/test-termote.sh

test-get:
	@chmod +x tests/test-get.sh
	@./tests/test-get.sh

test-entrypoints:
	@chmod +x tests/test-entrypoints.sh
	@./tests/test-entrypoints.sh

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
	./scripts/termote.sh uninstall all

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
