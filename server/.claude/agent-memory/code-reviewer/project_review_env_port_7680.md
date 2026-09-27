---
name: review-env-port-7680
description: On the WSL2 review machine 127.0.0.1:7680 is held by a listener invisible to ss (likely Windows host via mirrored networking); tests touching the default port fail there
metadata:
  type: project
---

On 2026-09-27 the reviewer's WSL2 env had 127.0.0.1:7680 unbindable (python bind -> EADDRINUSE, connect ok) while `ss -ltn` showed nothing; the user reported `make test` green in their shell.

**Why:** a test (TestStartEndToEnd at 84cfa7d) and `termote start` waited on the default port even when nothing was stopped, so a foreign listener on 7680 breaks them.

**How to apply:** when a termote test fails with "port 7680 is still in use", check for a hidden listener before blaming flakiness; it can also reveal a real non-hermetic default-port dependency.
