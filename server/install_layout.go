package main

import (
	"path/filepath"
	"strings"
)

// The installer lays a release out as:
//
//	~/.local/share/termote/versions/<v>/bin/termote   (one dir per version)
//	~/.local/share/termote/current -> versions/<v>    (symlink)
//	~/.local/bin/termote -> ../share/termote/current/bin/termote
//
// On Windows (%LOCALAPPDATA%\termote) current is a file naming the version
// and bin\termote.cmd runs versions\<v>\bin\termote.exe, since a junction
// cannot be replaced atomically.

// dataDir is the install root: $XDG_DATA_HOME/termote (default
// ~/.local/share/termote), or %LOCALAPPDATA%\termote on Windows.
func (c *cli) dataDir() string {
	if c.goos == "windows" {
		return filepath.Join(c.envDir("LOCALAPPDATA", filepath.Join(c.home, "AppData", "Local")), "termote")
	}
	return filepath.Join(c.envDir("XDG_DATA_HOME", filepath.Join(c.home, ".local", "share")), "termote")
}

func (c *cli) versionsDir() string { return filepath.Join(c.dataDir(), "versions") }

// currentExe is the path that always runs the current version.
func (c *cli) currentExe() string {
	if c.goos == "windows" {
		return filepath.Join(c.dataDir(), "bin", "termote.cmd")
	}
	return filepath.Join(c.dataDir(), "current", "bin", "termote")
}

// isInstalledRelease reports a binary running from versions/<v>/bin. c.exe
// has its symlinks resolved, so it points into versions/ even when started
// through current or ~/.local/bin.
func (c *cli) isInstalledRelease() bool {
	dirs := []string{c.versionsDir()}
	// The home dir itself may sit behind a symlink (macOS /var/folders).
	if resolved, err := filepath.EvalSymlinks(c.versionsDir()); err == nil {
		dirs = append(dirs, resolved)
	}
	for _, dir := range dirs {
		rel, err := filepath.Rel(dir, c.exe)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if parts := strings.Split(rel, string(filepath.Separator)); len(parts) == 3 && parts[1] == "bin" {
			return true
		}
	}
	return false
}

// stableExe is what a service runs: a path that survives update, so update
// only switches current and restarts. It is built from the install layout,
// never taken from c.exe, which names one version. A checkout or a binary
// copied elsewhere runs itself.
func (c *cli) stableExe() string {
	if c.isInstalledRelease() {
		return c.currentExe()
	}
	return c.exe
}
