---
name: Bug report
about: Report a bug with Termote
title: "[BUG] "
labels: "bug"
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is.

**Deployment Mode**

- [ ] Container (Docker/Podman)
- [ ] Native (macOS/Linux)
- [ ] Native (Windows with psmux)

**Environment**

- Termote version: [e.g., 0.1.5]
- Host OS: [e.g., Ubuntu 22.04, macOS 14, Windows 11]
- Container runtime (if applicable): [e.g., podman 5.x, docker 24.x]
- ttyd version (if native): [e.g., 1.7.4]

**Client Information**

- Device: [e.g., iPhone 15, Desktop PC]
- OS: [e.g., iOS 17, Windows 11, Android 14]
- Browser: [e.g., Chrome 120, Safari 17]
- PWA installed: [Yes/No]

**To Reproduce**

1. Deploy with '...'
2. Open terminal at '...'
3. Perform action '...'
4. See error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Screenshots/Logs**
If applicable, add screenshots or relevant logs.

```
# Paste logs here if available
# docker logs termote / podman logs termote
# termote health
```

**Component affected**

- [ ] PWA/Frontend
- [ ] Terminal (ttyd/tmux)
- [ ] Gestures/Touch
- [ ] Keyboard toolbar
- [ ] Session management
- [ ] tmux-api
- [ ] WebSocket proxy
- [ ] Authentication
- [ ] Connection/Reconnect
- [ ] Command history
- [ ] Quick actions
- [ ] Settings
- [ ] Update checker
- [ ] Deployment scripts (termote.sh/termote.ps1)
- [ ] Online installer (get.sh/get.ps1)
- [ ] Other: \_\_\_

**Additional context**
Any other context about the problem.
