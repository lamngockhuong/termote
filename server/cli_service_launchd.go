package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const launchdLabel = "app.ohnice.termote"

// launchdSupervisor runs serve as a launchd agent of the logged-in user.
type launchdSupervisor struct{ c *cli }

func (l *launchdSupervisor) Name() string    { return "launchd" }
func (l *launchdSupervisor) AutoStart() bool { return true }

func (l *launchdSupervisor) plistPath() string {
	return filepath.Join(l.c.home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func (l *launchdSupervisor) Available() bool {
	_, err := l.c.run.LookPath("launchctl")
	return err == nil
}

func (l *launchdSupervisor) Installed() bool { return fileExists(l.plistPath()) }

func (l *launchdSupervisor) domain() string  { return "gui/" + strconv.Itoa(os.Getuid()) }
func (l *launchdSupervisor) service() string { return l.domain() + "/" + launchdLabel }

func (l *launchdSupervisor) launchctl(args ...string) ([]byte, error) {
	return l.c.run.Output("", nil, "launchctl", args...)
}

// launchdPlist is the agent for `<exe> serve`. AbandonProcessGroup keeps the
// tmux server and its shells alive when launchd stops or restarts the
// server; KeepAlive restarts it only after a failure.
func launchdPlist(exe, logPath string, env map[string]string) string {
	esc := func(s string) string {
		var b strings.Builder
		xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + launchdLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + esc(exe) + `</string>
		<string>serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
`)
	for _, k := range sortedKeys(env) {
		fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", esc(k), esc(env[k]))
	}
	b.WriteString(`	</dict>
	<key>StandardOutPath</key>
	<string>` + esc(logPath) + `</string>
	<key>StandardErrorPath</key>
	<string>` + esc(logPath) + `</string>
</dict>
</plist>
`)
	return b.String()
}

// Install writes the plist; launchd reads it at every login. A changed plist
// is loaded again by Start.
func (l *launchdSupervisor) Install(exe string, env map[string]string) error {
	if err := ensureDir(filepath.Dir(l.plistPath())); err != nil {
		return err
	}
	plist := launchdPlist(exe, l.c.serverLog(), env)
	if b, err := os.ReadFile(l.plistPath()); err == nil && string(b) == plist {
		return nil
	}
	if err := os.WriteFile(l.plistPath(), []byte(plist), 0o644); err != nil {
		return err
	}
	// Unload the old definition so the next Start loads the new one.
	l.launchctl("bootout", l.service())
	return nil
}

func (l *launchdSupervisor) loaded() bool {
	_, err := l.launchctl("print", l.service())
	return err == nil
}

// Start loads the agent (RunAtLoad starts it) or, when already loaded,
// restarts it.
func (l *launchdSupervisor) Start() error {
	if !l.loaded() {
		if _, err := l.launchctl("bootstrap", l.domain(), l.plistPath()); err != nil {
			return fmt.Errorf("launchctl bootstrap %s: %w", l.domain(), err)
		}
		return nil
	}
	if _, err := l.launchctl("kickstart", "-k", l.service()); err != nil {
		return fmt.Errorf("launchctl kickstart %s: %w", l.service(), err)
	}
	return nil
}

// Stop unloads the agent; otherwise KeepAlive would not matter, but a
// kickstart or the next load would. The plist stays, so it loads at login.
func (l *launchdSupervisor) Stop() error {
	if !l.loaded() {
		return nil
	}
	if _, err := l.launchctl("bootout", l.service()); err != nil {
		return fmt.Errorf("launchctl bootout %s: %w", l.service(), err)
	}
	return nil
}

func (l *launchdSupervisor) Status() (bool, int, error) {
	out, err := l.launchctl("print", l.service())
	if err != nil {
		return false, 0, nil
	}
	return parseLaunchctlPrint(string(out))
}

// parseLaunchctlPrint reads the service's own "state = running" and
// "pid = N"; nested sections (endpoints, spawn info) come later and have
// their own state lines, so only the first of each counts.
func parseLaunchctlPrint(out string) (bool, int, error) {
	state, pid := "", 0
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " = ")
		if !ok {
			continue
		}
		switch {
		case k == "state" && state == "":
			state = v
		case k == "pid" && pid == 0:
			pid, _ = strconv.Atoi(v)
		}
	}
	return state == "running" && pid > 0, pid, nil
}

func (l *launchdSupervisor) Uninstall() error {
	l.launchctl("bootout", l.service())
	return removeFile(l.plistPath())
}
