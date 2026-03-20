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

- [ ] Container (all-in-one container)
- [ ] Native (no container)

**Environment**

- Host OS: [e.g., Ubuntu 22.04, macOS 14]
- Docker version (if applicable): [e.g., 24.0.7]
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
# docker logs termote
# journalctl -u termote-ttyd
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
- [ ] Deployment scripts
- [ ] Other: \_\_\_

**Additional context**
Any other context about the problem.
