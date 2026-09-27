#!/bin/bash
# Test cases for entrypoint.sh
# Usage: make test-entrypoints

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1 (expected: $2, got: $3)"
    FAILED=$((FAILED + 1))
}

test_syntax() {
    echo "=== Testing entrypoint.sh syntax ==="

    if bash -n "$PROJECT_DIR/entrypoint.sh" 2>/dev/null; then
        pass "entrypoint.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_user_setup() {
    echo ""
    echo "=== Testing user setup ==="

    # Verify group creation
    if grep -q "getent group" "$PROJECT_DIR/entrypoint.sh" && \
       grep -q "/etc/group" "$PROJECT_DIR/entrypoint.sh"; then
        pass "dynamic group creation present"
    else
        fail "group creation" "present" "not found"
    fi

    # Verify user creation
    if grep -q "getent passwd" "$PROJECT_DIR/entrypoint.sh" && \
       grep -q "/etc/passwd" "$PROJECT_DIR/entrypoint.sh"; then
        pass "dynamic user creation present"
    else
        fail "user creation" "present" "not found"
    fi

    # Verify home directory
    if grep -q "/home/termote" "$PROJECT_DIR/entrypoint.sh"; then
        pass "home directory set to /home/termote"
    else
        fail "home dir" "/home/termote" "not found"
    fi
}

test_auth_setup() {
    echo ""
    echo "=== Testing auth setup ==="

    # Verify password generation
    if grep -q "openssl rand" "$PROJECT_DIR/entrypoint.sh"; then
        pass "password generation present"
    else
        fail "password gen" "openssl rand" "not found"
    fi

    # Verify NO_AUTH check
    if grep -q 'NO_AUTH.*true' "$PROJECT_DIR/entrypoint.sh"; then
        pass "NO_AUTH check present"
    else
        fail "NO_AUTH" "check" "not found"
    fi

    # Verify TERMOTE_PASS environment
    if grep -q "TERMOTE_PASS" "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_PASS environment variable"
    else
        fail "TERMOTE_PASS" "present" "not found"
    fi
}

test_services() {
    echo ""
    echo "=== Testing services ==="

    if grep -qi "ttyd" "$PROJECT_DIR/entrypoint.sh"; then
        fail "no ttyd" "none" "$(grep -i ttyd "$PROJECT_DIR/entrypoint.sh" | head -1)"
    else
        pass "ttyd removed"
    fi

    if grep -q "tmux has-session -t main" "$PROJECT_DIR/entrypoint.sh" &&
        grep -q "tmux new-session -d -s main" "$PROJECT_DIR/entrypoint.sh"; then
        pass "creates tmux session 'main' when missing"
    else
        fail "tmux session" "main" "not found"
    fi

    # Shells inherit the tmux server's environment; the password must not be in it
    if grep -q "env -u TERMOTE_PASS tmux new-session" "$PROJECT_DIR/entrypoint.sh"; then
        pass "tmux session starts without TERMOTE_PASS"
    else
        fail "tmux env" "env -u TERMOTE_PASS" "password reaches the shells"
    fi

    # exec: tmux-api gets SIGTERM from tini directly, no shell in between
    if grep -qE '^exec /usr/local/bin/tmux-api$' "$PROJECT_DIR/entrypoint.sh"; then
        pass "execs tmux-api as the last step"
    else
        fail "exec tmux-api" "exec /usr/local/bin/tmux-api" "not found"
    fi
}

test_serve_config() {
    echo ""
    echo "=== Testing serve configuration ==="

    for var in TERMOTE_PORT TERMOTE_BIND TERMOTE_PWA_DIR TERMOTE_USER; do
        if grep -q "export $var=" "$PROJECT_DIR/entrypoint.sh"; then
            pass "$var configured"
        else
            fail "$var" "exported" "not found"
        fi
    done
}

test_dockerfile() {
    echo ""
    echo "=== Testing Dockerfile ==="
    local df="$PROJECT_DIR/Dockerfile"

    if grep -qE '^FROM debian:stable-slim@sha256:[0-9a-f]{64}$' "$df"; then
        pass "base image is debian:stable-slim pinned by digest"
    else
        fail "base image" "debian:stable-slim@sha256:..." "$(grep '^FROM' "$df")"
    fi
    if grep -q 'ENTRYPOINT \["/usr/bin/tini", "-s", "--", "/entrypoint.sh"\]' "$df"; then
        pass "tini is the entrypoint"
    else
        fail "entrypoint" "tini -s -- /entrypoint.sh" "$(grep ENTRYPOINT "$df")"
    fi
    if grep -qi ttyd "$df"; then
        fail "no ttyd" "none" "$(grep -i ttyd "$df" | head -1)"
    else
        pass "no ttyd in Dockerfile"
    fi
}

# Runs the built image; set TERMOTE_TEST_IMAGE (CI builds termote:test).
test_container_runtime() {
    echo ""
    echo "=== Testing container runtime ==="
    local image="${TERMOTE_TEST_IMAGE:-}" rt name="termote-entrypoint-test-$$"
    if [[ -z "$image" ]]; then
        echo "SKIP: TERMOTE_TEST_IMAGE not set"
        return
    fi
    rt=$(command -v docker || command -v podman)
    if [[ -z "$rt" ]]; then
        echo "SKIP: no docker or podman"
        return
    fi

    "$rt" rm -f "$name" >/dev/null 2>&1
    if ! "$rt" run -d --name "$name" --user 1000:1000 -e TERMOTE_PASS=test-pass "$image" >/dev/null; then
        fail "container start" "running" "run failed"
        return
    fi
    # Wait for tmux-api to answer inside the container
    local i up=false
    for i in $(seq 1 20); do
        if "$rt" exec "$name" curl -fs -o /dev/null -u admin:test-pass http://127.0.0.1:7680/api/mux/health; then
            up=true
            break
        fi
        sleep 0.5
    done
    if [[ "$up" == true ]]; then pass "tmux-api answers /api/mux/health"; else fail "health" "200" "no answer"; fi

    local pid1
    pid1=$("$rt" exec "$name" cat /proc/1/comm)
    if [[ "$pid1" == "tini" ]]; then pass "PID 1 is tini"; else fail "PID 1" "tini" "$pid1"; fi

    if "$rt" exec "$name" tmux has-session -t main 2>/dev/null; then
        pass "session 'main' exists at start"
    else
        fail "session main" "exists" "missing"
    fi

    # Killing the tmux server orphans its shells; tini must reap them.
    "$rt" exec "$name" tmux kill-server >/dev/null 2>&1
    sleep 1
    local zombies
    zombies=$("$rt" exec "$name" sh -c 'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l' | tr -d ' ')
    if [[ "$zombies" == "0" ]]; then pass "no zombies after tmux kill-server"; else fail "zombies" "0" "$zombies"; fi

    local start elapsed
    start=$(date +%s)
    "$rt" stop "$name" >/dev/null
    elapsed=$(($(date +%s) - start))
    if [[ $elapsed -lt 10 ]]; then pass "stops in ${elapsed}s (< 10s)"; else fail "stop time" "< 10s" "${elapsed}s"; fi
    "$rt" rm -f "$name" >/dev/null 2>&1
}

# Run all tests
echo "Running entrypoint tests..."
echo ""

test_syntax
test_user_setup
test_auth_setup
test_services
test_serve_config
test_dockerfile
test_container_runtime

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
