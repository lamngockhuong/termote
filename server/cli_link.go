package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (c *cli) userBinDir() string { return filepath.Join(c.home, ".local", "bin") }

// linkSource is what the `termote` command runs: the current version of an
// install, or the checkout shim (which builds on demand).
func (c *cli) linkSource() string {
	if c.isInstalledRelease() {
		return c.currentExe()
	}
	return c.shimPath()
}

// cmdLink publishes the `termote` command: a symlink in ~/.local/bin on
// Unix. On Windows an install puts its own bin dir on the user PATH, and a
// checkout gets a termote.cmd in ~/.local/bin calling the shim.
func (c *cli) cmdLink() error {
	if c.goos == "windows" {
		return c.linkWindows()
	}
	source := c.linkSource()
	if c.isCheckout() {
		c.infof("Linking the git checkout (development mode)")
	}
	target := filepath.Join(c.userBinDir(), "termote")
	created, err := c.symlink(source, target)
	if err != nil {
		return err
	}
	if created {
		c.infof("Created symlink: %s -> %s", target, source)
	} else {
		c.infof("Already linked: %s -> %s", target, source)
	}
	c.checkPath(c.userBinDir())
	return nil
}

// symlink points target at source, replacing an older termote symlink but
// never a regular file. It reports created=false with no error when target
// already pointed at source.
func (c *cli) symlink(source, target string) (bool, error) {
	if st, err := os.Lstat(target); err == nil {
		if st.Mode()&os.ModeSymlink == 0 {
			return false, fmt.Errorf("%s exists and is not a symlink; move it aside and run: termote link", target)
		}
		if cur, _ := os.Readlink(target); cur == source {
			return false, nil
		}
		if err := os.Remove(target); err != nil {
			return false, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return false, err
	}
	if err := os.Symlink(source, target); err != nil {
		return false, err
	}
	return true, nil
}

// onPath reports whether dir is on PATH.
func (c *cli) onPath(dir string) bool {
	for _, p := range filepath.SplitList(c.getenv("PATH")) {
		if strings.EqualFold(filepath.Clean(p), filepath.Clean(dir)) {
			return true
		}
	}
	return false
}

// checkPath warns when dir is not on PATH.
func (c *cli) checkPath(dir string) {
	if c.onPath(dir) {
		c.infof("You can now run 'termote' from anywhere")
		return
	}
	c.warnf("%s is not in PATH", dir)
	if c.goos == "windows" {
		fmt.Fprintf(c.out, "Add it permanently:\n  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';%s', 'User')\n", dir)
		return
	}
	fmt.Fprintf(c.out, "Add to ~/.bashrc or ~/.zshrc:\n  export PATH=\"%s:$PATH\"\n", dir)
}

func (c *cli) windowsLinkFile() string { return filepath.Join(c.userBinDir(), "termote.cmd") }

// userPathScript adds (or removes) dir on the user's PATH, the registry
// value new terminals read.
func userPathScript(dir string, add bool) string {
	q := strings.ReplaceAll(dir, "'", "''")
	s := "$d='" + q + "'; $p=[Environment]::GetEnvironmentVariable('Path','User'); " +
		"$parts=@($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $d.TrimEnd('\\')) }); "
	if add {
		s += "$parts += $d; "
	}
	return s + "[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')"
}

func (c *cli) linkWindows() error {
	if c.isInstalledRelease() {
		if err := c.ensureWindowsLauncher(); err != nil {
			return err
		}
		dir := filepath.Dir(c.currentExe())
		if c.onPath(dir) {
			c.infof("Already on PATH: %s", dir)
			return nil
		}
		if err := c.run.Run("", nil, "powershell", "-NoProfile", "-Command", userPathScript(dir, true)); err != nil {
			c.warnf("Could not add %s to PATH: %v", dir, err)
			c.checkPath(dir)
			return nil
		}
		c.infof("Added %s to your PATH. Open a new terminal to use 'termote'.", dir)
		return nil
	}
	cmdFile := c.windowsLinkFile()
	source := c.shimPath()
	if err := os.MkdirAll(c.userBinDir(), 0o755); err != nil {
		return err
	}
	content := "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + source + "\" %*\r\n"
	if b, err := os.ReadFile(cmdFile); err == nil && string(b) == content {
		c.infof("Already linked: %s -> %s", cmdFile, source)
	} else {
		if err := os.WriteFile(cmdFile, []byte(content), 0o644); err != nil {
			return err
		}
		c.infof("Created: %s", cmdFile)
	}
	c.checkPath(c.userBinDir())
	return nil
}

// ownLink reports whether target is a link this command published: a
// symlink to a termote.sh shim or to an install's current/bin/termote.
func (c *cli) ownLink(target string) bool {
	st, err := os.Lstat(target)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		return false
	}
	cur, _ := os.Readlink(target)
	return filepath.Base(cur) == "termote.sh" ||
		strings.HasSuffix(filepath.ToSlash(cur), "/current/bin/termote")
}

func (c *cli) cmdUnlink() error {
	removed := false
	if c.goos == "windows" {
		dir := filepath.Dir(c.currentExe())
		if c.isInstalledRelease() || c.onPath(dir) {
			if err := c.run.Run("", nil, "powershell", "-NoProfile", "-Command", userPathScript(dir, false)); err == nil {
				c.infof("Removed %s from your PATH", dir)
				removed = true
			}
		}
		if fileExists(c.windowsLinkFile()) {
			if err := os.Remove(c.windowsLinkFile()); err == nil {
				c.infof("Removed: %s", c.windowsLinkFile())
				removed = true
			}
		}
	} else if t := filepath.Join(c.userBinDir(), "termote"); c.ownLink(t) {
		if err := os.Remove(t); err != nil {
			c.warnf("Cannot remove %s: %v", t, err)
		} else {
			c.infof("Removed: %s", t)
			removed = true
		}
	}
	if !removed {
		c.infof("No link found")
	}
	return nil
}
