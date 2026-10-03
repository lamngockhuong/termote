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

    # A generated password goes to a 0600 file, not to the container log
    if grep -q 'umask 077 && mkdir -p "${pass_file%/\*}" && printf' "$PROJECT_DIR/entrypoint.sh" &&
        ! grep -B2 'Password: \$TERMOTE_PASS' "$PROJECT_DIR/entrypoint.sh" | grep -q 'auto-generated'; then
        pass "generated password saved to a private file"
    else
        fail "generated password" "written to a 0600 file" "printed to the log"
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
    if grep -q 'env "${unset_termote\[@\]}" tmux new-session' "$PROJECT_DIR/entrypoint.sh" &&
        grep -q '== TERMOTE_\*' "$PROJECT_DIR/entrypoint.sh"; then
        pass "tmux session starts without any TERMOTE_* variable"
    else
        fail "tmux env" "every TERMOTE_* unset" "a TERMOTE_* variable reaches the shells"
    fi

    if grep -q '^herdr)$' "$PROJECT_DIR/entrypoint.sh" &&
        grep -q 'herdr workspace create --label main' "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_MUX=herdr starts herdr and creates workspace 'main'"
    else
        fail "herdr branch" "herdr) ... workspace create --label main" "not found"
    fi
    if grep -q 'env "${unset_termote\[@\]}" XDG_CONFIG_HOME=/tmp herdr server' "$PROJECT_DIR/entrypoint.sh"; then
        pass "herdr server starts without any TERMOTE_* variable"
    else
        fail "herdr env" "every TERMOTE_* unset" "a TERMOTE_* variable reaches the shells"
    fi
    # termote serve and herdr must agree on the socket
    if grep -q '^    export HERDR_SOCKET_PATH=/tmp/herdr/herdr.sock$' "$PROJECT_DIR/entrypoint.sh"; then
        pass "exports HERDR_SOCKET_PATH for termote serve"
    else
        fail "herdr socket" "export HERDR_SOCKET_PATH" "not found"
    fi
    # termote serve reads its config from XDG_CONFIG_HOME; /tmp is world-writable
    if grep -q 'export.*XDG_CONFIG_HOME' "$PROJECT_DIR/entrypoint.sh"; then
        fail "no XDG_CONFIG_HOME export" "set for herdr only" "$(grep 'export.*XDG_CONFIG_HOME' "$PROJECT_DIR/entrypoint.sh")"
    else
        pass "XDG_CONFIG_HOME is set for herdr only, not for termote serve"
    fi
    if grep -q 'unknown TERMOTE_MUX' "$PROJECT_DIR/entrypoint.sh"; then
        pass "rejects an unknown TERMOTE_MUX"
    else
        fail "unknown mux" "error" "not found"
    fi

    # exec: the server gets SIGTERM from tini directly, no shell in between
    if grep -qE '^exec /usr/local/bin/termote serve$' "$PROJECT_DIR/entrypoint.sh"; then
        pass "execs termote serve as the last step"
    else
        fail "exec termote" "exec /usr/local/bin/termote serve" "not found"
    fi
}

test_serve_config() {
    echo ""
    echo "=== Testing serve configuration ==="

    for var in TERMOTE_PORT TERMOTE_BIND TERMOTE_USER; do
        if grep -q "export $var=" "$PROJECT_DIR/entrypoint.sh"; then
            pass "$var configured"
        else
            fail "$var" "exported" "not found"
        fi
    done
    # The PWA is embedded in the binary; a PWA dir would override it
    if grep -q "TERMOTE_PWA_DIR" "$PROJECT_DIR/entrypoint.sh"; then
        fail "no TERMOTE_PWA_DIR" "unset" "$(grep TERMOTE_PWA_DIR "$PROJECT_DIR/entrypoint.sh")"
    else
        pass "serves the embedded PWA (no TERMOTE_PWA_DIR)"
    fi
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
    # herdr is pinned: a version and a checksum per arch, checked at build
    if grep -qE '^ARG HERDR_VERSION=[0-9]+\.[0-9]+\.[0-9]+$' "$df" &&
        grep -qE '^ARG HERDR_SHA256_AMD64=[0-9a-f]{64}$' "$df" &&
        grep -qE '^ARG HERDR_SHA256_ARM64=[0-9a-f]{64}$' "$df" &&
        grep -q 'sha256sum -c -' "$df"; then
        pass "herdr pinned by version and sha256"
    else
        fail "herdr pin" "HERDR_VERSION + sha256 per arch" "not found"
    fi
}

# Runs the built image; set TERMOTE_TEST_IMAGE (CI builds termote:test).
test_container_runtime() {
    local image="${TERMOTE_TEST_IMAGE:-}"
    echo ""
    echo "=== Testing container runtime ==="
    if [[ -z "$image" ]]; then
        echo "SKIP: TERMOTE_TEST_IMAGE not set"
        return
    fi
    RT=$(command -v docker || command -v podman)
    if [[ -z "$RT" ]]; then
        echo "SKIP: no docker or podman"
        return
    fi
    runtime_backend "$image" tmux
    runtime_backend "$image" herdr
    runtime_unknown_mux "$image"
}

# runtime_backend IMAGE MUX runs the image with TERMOTE_MUX=MUX.
runtime_backend() {
    local image="$1" mux="$2" rt="$RT" name="termote-entrypoint-test-$$"
    echo ""
    echo "--- backend: $mux ---"

    "$rt" rm -f "$name" >/dev/null 2>&1
    if ! "$rt" run -d --name "$name" --user 1000:1000 -w /tmp -e TERMOTE_PASS=test-pass -e TERMOTE_MUX="$mux" "$image" >/dev/null; then
        fail "[$mux] container start" "running" "run failed"
        return
    fi
    # Wait for the server to answer inside the container
    local i up=false
    for i in $(seq 1 30); do
        if "$rt" exec "$name" curl -fs -o /dev/null -u admin:test-pass http://127.0.0.1:7680/api/mux/health; then
            up=true
            break
        fi
        sleep 0.5
    done
    if [[ "$up" == true ]]; then pass "[$mux] server answers /api/mux/health"; else fail "[$mux] health" "200" "no answer: $("$rt" logs "$name" 2>&1 | tail -5)"; fi

    # The real PWA, not the placeholder a binary built without it serves
    local index
    index=$("$rt" exec "$name" curl -fs -u admin:test-pass http://127.0.0.1:7680/ || true)
    if [[ "$index" == *"/assets/"* ]]; then
        pass "[$mux] GET / serves the embedded PWA"
    else
        fail "[$mux] GET /" "HTML referencing /assets/" "$(echo "$index" | head -c 200)"
    fi

    local pid1 xdg
    # termote serve must not read its config from /tmp
    xdg=$("$rt" exec "$name" sh -c 'tr "\0" "\n" </proc/$(for p in /proc/[0-9]*; do [ "$(tr "\0" " " <$p/cmdline 2>/dev/null)" = "/usr/local/bin/termote serve " ] && basename $p; done | head -1)/environ | grep -c "^XDG_CONFIG_HOME="' || true)
    if [[ "${xdg:-0}" == "0" ]]; then pass "[$mux] termote serve has no XDG_CONFIG_HOME"; else fail "[$mux] serve env" "no XDG_CONFIG_HOME" "set"; fi

    pid1=$("$rt" exec "$name" cat /proc/1/comm)
    if [[ "$pid1" == "tini" ]]; then pass "[$mux] PID 1 is tini"; else fail "[$mux] PID 1" "tini" "$pid1"; fi

    # The server lists the shared session through the API
    local groups
    groups=$("$rt" exec "$name" curl -fs -u admin:test-pass http://127.0.0.1:7680/api/mux/snapshot || true)
    if [[ "$groups" == *'"main"'* ]]; then
        pass "[$mux] /api/mux/snapshot lists 'main'"
    else
        fail "[$mux] groups" "main" "$(echo "$groups" | head -c 200)"
    fi

    if [[ "$mux" == tmux ]]; then
        # The shells of the session see no TERMOTE_* variable.
        local leaked
        leaked=$("$rt" exec "$name" sh -c 'tmux show-environment -g | grep -c "^TERMOTE_"' || true)
        if [[ "${leaked:-0}" == "0" ]]; then pass "[tmux] tmux server has no TERMOTE_* variable"; else fail "[tmux] tmux env" "0" "$leaked"; fi

        if "$rt" exec "$name" tmux has-session -t main 2>/dev/null; then
            pass "[tmux] session 'main' exists at start"
        else
            fail "[tmux] session main" "exists" "missing"
        fi
        # Killing the tmux server orphans its shells; tini must reap them.
        "$rt" exec "$name" tmux kill-server >/dev/null 2>&1
    else
        local herdr_env='XDG_CONFIG_HOME=/tmp HERDR_SOCKET_PATH=/tmp/herdr/herdr.sock'
        if "$rt" exec "$name" sh -c "$herdr_env herdr status server" | grep -q '^status: running'; then
            pass "[herdr] herdr server is running"
        else
            fail "[herdr] herdr status" "running" "not running"
        fi
        if "$rt" exec "$name" sh -c "$herdr_env herdr workspace list" | grep -q '"label":"main"'; then
            pass "[herdr] workspace 'main' exists at start"
        else
            fail "[herdr] workspace main" "exists" "missing"
        fi
        local hpid ppid leaked
        hpid=$("$rt" exec "$name" sh -c 'for p in /proc/[0-9]*; do [ "$(tr "\0" " " <$p/cmdline 2>/dev/null)" = "herdr server " ] && basename $p; done' | head -1)
        if [[ -z "$hpid" ]]; then
            fail "[herdr] herdr server pid" "found" "none"
        else
            leaked=$("$rt" exec "$name" sh -c "tr '\0' '\n' </proc/$hpid/environ | grep -c '^TERMOTE_'" || true)
            if [[ "${leaked:-0}" == "0" ]]; then pass "[herdr] herdr server has no TERMOTE_* variable"; else fail "[herdr] herdr env" "0" "$leaked"; fi
            ppid=$("$rt" exec "$name" sh -c "awk '/^PPid:/ {print \$2}' /proc/$hpid/status")
            if [[ "$ppid" == "1" ]]; then pass "[herdr] herdr server is a child of tini"; else fail "[herdr] herdr parent" "1" "$ppid"; fi
        fi
        # Stopping the herdr server orphans its shells; tini must reap them.
        "$rt" exec "$name" sh -c "$herdr_env herdr server stop" >/dev/null 2>&1
    fi
    sleep 1
    local zombies
    zombies=$("$rt" exec "$name" sh -c 'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l' | tr -d ' ')
    if [[ "$zombies" == "0" ]]; then pass "[$mux] no zombies after the $mux server stops"; else fail "[$mux] zombies" "0" "$zombies"; fi

    local start elapsed
    start=$(date +%s)
    "$rt" stop "$name" >/dev/null
    elapsed=$(($(date +%s) - start))
    if [[ $elapsed -lt 10 ]]; then pass "[$mux] stops in ${elapsed}s (< 10s)"; else fail "[$mux] stop time" "< 10s" "${elapsed}s"; fi
    "$rt" rm -f "$name" >/dev/null 2>&1
}

# runtime_unknown_mux IMAGE: an unknown backend stops the container with an error.
runtime_unknown_mux() {
    local image="$1" rt="$RT" out code
    echo ""
    echo "--- backend: zellij (unknown) ---"
    out=$("$rt" run --rm --user 1000:1000 -e TERMOTE_PASS=test-pass -e TERMOTE_MUX=zellij "$image" 2>&1)
    code=$?
    if [[ $code -ne 0 && "$out" == *"unknown TERMOTE_MUX 'zellij'"* ]]; then
        pass "TERMOTE_MUX=zellij exits $code with an error"
    else
        fail "unknown mux" "exit != 0 + error" "exit $code: $(echo "$out" | tail -1)"
    fi
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
