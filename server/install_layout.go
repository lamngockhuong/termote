package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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

// containerMarkers are the files a container runtime leaves at the root of
// every container: Docker's /.dockerenv, Podman's /run/.containerenv.
var containerMarkers = []string{"/.dockerenv", "/run/.containerenv"}

// installKind names how this binary was installed, so the PWA can say how to
// update it: "release" (the installer's layout, `termote update`),
// "checkout" (a git checkout, pull and rebuild), "container" (the image, run
// again by the host's termote) or "unknown" (a binary copied by hand).
func (c *cli) installKind() string {
	switch {
	case c.isInstalledRelease():
		return "release"
	case c.isCheckout():
		return "checkout"
	case slices.ContainsFunc(containerMarkers, fileExists):
		return "container"
	}
	return "unknown"
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

// pointerPath is where the "current" or "previous" version is recorded: a
// symlink to versions/<v> on Unix, a one-line file on Windows.
func (c *cli) pointerPath(name string) string {
	if c.goos == "windows" {
		return filepath.Join(c.dataDir(), name+".txt")
	}
	return filepath.Join(c.dataDir(), name)
}

// pointedVersion returns the version a pointer names, or "".
func (c *cli) pointedVersion(name string) string {
	if c.goos == "windows" {
		b, err := os.ReadFile(c.pointerPath(name))
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	target, err := os.Readlink(c.pointerPath(name))
	if err != nil {
		return ""
	}
	return filepath.Base(target)
}

func (c *cli) currentVersion() string  { return c.pointedVersion("current") }
func (c *cli) previousVersion() string { return c.pointedVersion("previous") }

// setPointer points name at version atomically: the new symlink (or file) is
// written beside the old one and renamed over it, so a crash leaves either
// the old or the new target, never none.
func (c *cli) setPointer(name, version string) error {
	path := c.pointerPath(name)
	tmp := path + ".tmp"
	os.Remove(tmp)
	var err error
	if c.goos == "windows" {
		err = os.WriteFile(tmp, []byte(version+"\r\n"), 0o644)
	} else {
		err = os.Symlink(filepath.Join("versions", version), tmp)
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// switchCurrent makes version current and remembers the one it replaces as
// previous, the version update rolls back to and pruning keeps.
func (c *cli) switchCurrent(version string) error {
	old := c.currentVersion()
	if err := c.setPointer("current", version); err != nil {
		return fmt.Errorf("point current at %s: %w", version, err)
	}
	if old != "" && old != version {
		if err := c.setPointer("previous", old); err != nil {
			return fmt.Errorf("record previous version %s: %w", old, err)
		}
	}
	return c.ensureWindowsLauncher()
}

// windowsLauncher is bin\termote.cmd: it runs the current version, so the
// command on PATH and the Scheduled Task never change on update.
//
// setlocal keeps its variable out of the caller's session (and so out of
// the server's environment); a missing current.txt fails instead of running
// a value left from before. "(goto) 2>nul" ends the batch before the exe
// runs (the rest of the line is already parsed): cmd.exe reads a batch file
// line by line, so once uninstall has deleted this file, reading on would
// fail with "The system cannot find the path specified". "& exit /b" does
// not avoid that (it reads to the end of the file) and loses the exit code
// under "cmd /c", which is how PowerShell runs a .cmd.
const windowsLauncher = "@echo off\r\n" +
	"rem Written by the Termote installer: runs the version named in current.txt.\r\n" +
	"setlocal\r\n" +
	"set \"_termote_version=\"\r\n" +
	"set /p _termote_version=<\"%~dp0..\\current.txt\"\r\n" +
	"if not defined _termote_version (echo termote: %~dp0..\\current.txt names no version; reinstall Termote 1>&2 & exit /b 1)\r\n" +
	"(goto) 2>nul & \"%~dp0..\\versions\\%_termote_version%\\bin\\termote.exe\" %*\r\n"

func (c *cli) ensureWindowsLauncher() error {
	if c.goos != "windows" {
		return nil
	}
	path := c.currentExe()
	if b, err := os.ReadFile(path); err == nil && string(b) == windowsLauncher {
		return nil
	}
	if err := ensureDir(filepath.Dir(path)); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(windowsLauncher), 0o644)
}

// versionBinary is versions/<v>/bin/termote[.exe].
func (c *cli) versionBinary(version string) string {
	return filepath.Join(c.versionsDir(), version, "bin", "termote"+c.exeSuffix())
}

// installVersion unpacks a verified release archive into versions/<v>. The
// archive holds termote-<v>-<os>-<arch>/bin/termote; it is unpacked beside
// versions/ and renamed into place, so a half-written version never exists.
func (c *cli) installVersion(archive, version string) error {
	if err := ensureDir(c.versionsDir()); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(c.dataDir(), ".unpack-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if strings.HasSuffix(archive, ".zip") {
		err = extractZip(archive, stage)
	} else {
		err = extractTarball(archive, stage)
	}
	if err != nil {
		return fmt.Errorf("unpack %s: %w", filepath.Base(archive), err)
	}
	bin := filepath.Join(stage, "bin", "termote"+c.exeSuffix())
	if st, err := os.Stat(bin); err != nil || st.IsDir() {
		return fmt.Errorf("%s does not contain bin/termote%s; refusing to install it", filepath.Base(archive), c.exeSuffix())
	}
	dst := filepath.Join(c.versionsDir(), version)
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return os.Rename(stage, dst)
}

// removeInstall deletes the install but its state dir (Windows keeps the
// logs inside the install root), the current pointer first so a half-removed
// install never looks installed. It returns what could not be removed yet:
// Windows cannot delete the binary running this command.
func (c *cli) removeInstall() []string {
	os.Remove(c.pointerPath("current"))
	entries, _ := os.ReadDir(c.dataDir())
	var left []string
	for _, e := range entries {
		path := filepath.Join(c.dataDir(), e.Name())
		// The logs and (Windows) the trash sit in the install root; they
		// go only with --purge, which removed them already.
		if path == c.stateDir() || path == c.trashDir() {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			left = append(left, path)
		}
	}
	if len(left) == 0 {
		os.Remove(c.dataDir()) // only when empty (no state dir inside)
		c.infof("Removed the install in %s", c.dataDir())
	}
	return left
}

// cacheDir is the server's os.UserCacheDir worked out from this CLI's home
// and environment. On Windows it holds the install root
// (%LOCALAPPDATA%\termote).
func (c *cli) cacheDir() string {
	switch c.goos {
	case "windows":
		return c.envDir("LOCALAPPDATA", filepath.Join(c.home, "AppData", "Local"))
	case "darwin":
		return filepath.Join(c.home, "Library", "Caches")
	}
	return c.envDir("XDG_CACHE_HOME", filepath.Join(c.home, ".cache"))
}

// uploadsDir is the server's upload store (uploadDir).
func (c *cli) uploadsDir() string { return filepath.Join(c.cacheDir(), "termote", "uploads") }

// trashDir is the server's trash (trashDir): what the Files view deleted.
func (c *cli) trashDir() string { return filepath.Join(c.cacheDir(), "termote", "trash") }

// removeUploads deletes the images sent from the PWA: the store is a cache
// (7-day retention), so nothing in it is worth keeping once Termote goes.
// It returns the store when it could not be removed yet.
func (c *cli) removeUploads() []string {
	return c.removeCacheDir(c.uploadsDir(), "Removed the uploaded images in %s")
}

// removeTrash deletes the files the Files view deleted, for uninstall
// --purge: they are the user's files, not a cache, so a plain uninstall
// keeps them.
func (c *cli) removeTrash() []string {
	return c.removeCacheDir(c.trashDir(), "Removed the files deleted from the Files view in %s")
}

// removeCacheDir deletes dir, then its termote parent when that leaves it
// empty. It returns dir when it could not be removed yet.
func (c *cli) removeCacheDir(dir, done string) []string {
	if !isDir(dir) {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return []string{dir}
	}
	if parent := filepath.Dir(dir); parent != c.dataDir() {
		os.Remove(parent) // only when empty
	}
	c.infof(done, dir)
	return nil
}

// purgeData deletes the config (saved options, password, secret) and the
// state dir (logs, PID file), for uninstall --purge. It returns what could
// not be removed yet.
func (c *cli) purgeData() []string {
	var left []string
	for _, dir := range []string{c.configDir(), c.stateDir()} {
		if !isDir(dir) {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			left = append(left, dir)
			continue
		}
		c.infof("Removed %s", dir)
	}
	return left
}

// removeLater deletes paths once this process has exited, through a
// detached PowerShell with no window that waits for it, retrying while
// antivirus or a closing handle holds a file, then removes the install root
// when that leaves it empty. Only Windows locks a running binary, so other
// systems never get here; without that process the user is told what to
// delete by hand.
func (c *cli) removeLater(paths []string) {
	if len(paths) == 0 {
		return
	}
	if c.goos == "windows" && c.startHidden != nil {
		if err := c.startHidden(removeLaterScript(c.pid, paths, c.dataDir())); err == nil {
			c.infof("%s is in use by this command; it is removed once the command exits", strings.Join(paths, ", "))
			return
		}
	}
	c.warnf("Could not remove %s yet (in use); delete it once this command has exited", strings.Join(paths, ", "))
}

// removeLaterScript is the PowerShell removeLater runs: wait for pid (at
// most two minutes), remove each path for up to 30 seconds, then the
// install root if it is empty.
func removeLaterScript(pid int, paths []string, root string) string {
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = psQuote(p)
	}
	return "$ErrorActionPreference = 'SilentlyContinue'\n" +
		fmt.Sprintf("Wait-Process -Id %d -Timeout 120\n", pid) +
		"$paths = @(" + strings.Join(quoted, ",") + ")\n" +
		"for ($i = 0; $i -lt 30; $i++) {\n" +
		"  $paths | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force }\n" +
		"  if (-not ($paths | Where-Object { Test-Path -LiteralPath $_ })) { break }\n" +
		"  Start-Sleep -Seconds 1\n" +
		"}\n" +
		"$root = " + psQuote(root) + "\n" +
		"if ((Test-Path -LiteralPath $root) -and -not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }\n"
}

// psQuote quotes s as a PowerShell single-quoted string.
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// pruneVersions keeps current and previous and removes every other version.
// A version still locked (Windows: a running binary, antivirus) stays until
// the next update.
func (c *cli) pruneVersions() {
	keep := []string{c.currentVersion(), c.previousVersion()}
	entries, err := os.ReadDir(c.versionsDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || slices.Contains(keep, e.Name()) || keep[0] == "" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(c.versionsDir(), e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			c.warnf("Could not remove the old version %s yet (%v); the next update retries", e.Name(), err)
		}
	}
}
