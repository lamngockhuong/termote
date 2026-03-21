# Termote Makefile
# Usage: make <target>

.PHONY: help build test test-deploy test-uninstall test-install test-get test-health-check test-setup-auth test-entrypoints deploy-docker deploy-hybrid deploy-native clean release release-dry

# Default target
help:
	@echo "Termote - Terminal Remote Control"
	@echo ""
	@echo "Build:"
	@echo "  make build          Build PWA and tmux-api"
	@echo "  make build-pwa      Build PWA only"
	@echo "  make build-api      Build tmux-api only"
	@echo ""
	@echo "Deploy:"
	@echo "  make deploy-docker  Deploy all-in-one container"
	@echo "  make deploy-hybrid  Deploy hybrid (docker + native ttyd)"
	@echo "  make deploy-native  Deploy native (systemd + nginx)"
	@echo ""
	@echo "Test:"
	@echo "  make test              Run all tests"
	@echo "  make test-deploy       Test deploy.sh"
	@echo "  make test-uninstall    Test uninstall.sh"
	@echo "  make test-install      Test install.sh"
	@echo "  make test-get          Test get.sh"
	@echo "  make test-health-check Test health-check.sh"
	@echo "  make test-setup-auth   Test setup-auth.sh"
	@echo "  make test-entrypoints  Test entrypoint scripts"
	@echo ""
	@echo "Release:"
	@echo "  make release        Tag and push new release (VERSION=x.y.z)"
	@echo "  make release-dry    Show what would be released"
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

# Deploy targets
deploy-docker:
	./scripts/deploy.sh --docker

deploy-docker-lan:
	./scripts/deploy.sh --docker --lan

deploy-hybrid:
	./scripts/deploy.sh --hybrid

deploy-hybrid-lan:
	./scripts/deploy.sh --hybrid --lan

deploy-native:
	./scripts/deploy.sh --native

deploy-native-lan:
	./scripts/deploy.sh --native --lan

# Test targets
test: test-deploy test-uninstall test-install test-get test-health-check test-setup-auth test-entrypoints
	@echo ""
	@echo "All tests completed!"

test-deploy:
	@chmod +x tests/test-deploy.sh
	@./tests/test-deploy.sh

test-uninstall:
	@chmod +x tests/test-uninstall.sh
	@./tests/test-uninstall.sh

test-install:
	@chmod +x tests/test-install.sh
	@./tests/test-install.sh

test-get:
	@chmod +x tests/test-get.sh
	@./tests/test-get.sh

test-health-check:
	@chmod +x tests/test-health-check.sh
	@./tests/test-health-check.sh

test-setup-auth:
	@chmod +x tests/test-setup-auth.sh
	@./tests/test-setup-auth.sh

test-entrypoints:
	@chmod +x tests/test-entrypoints.sh
	@./tests/test-entrypoints.sh

# Health check
health:
	./scripts/health-check.sh

# Cleanup
clean:
	docker compose down 2>/dev/null || true
	docker stop termote termote-hybrid 2>/dev/null || true
	docker rm termote termote-hybrid 2>/dev/null || true
	rm -f docker-compose.override.yml
	rm -f nginx/nginx-docker.conf.tmp
	rm -f nginx/nginx-hybrid.conf.tmp

uninstall:
	./scripts/uninstall.sh --all

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
