package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// systemLinkPath is where `link` puts the global command first on Unix;
// ~/.local/bin is the fallback that needs no root.
var systemLinkPath = "/usr/local/bin/termote"

func (c *cli) userBinDir() string { return filepath.Join(c.home, ".local", "bin") }

func (c *cli) cmdLink() error {
	if c.goos == "windows" {
		return c.linkWindows()
	}
	source := c.shimPath()
	if c.isCheckout() {
		c.infof("Linking the git checkout (development mode)")
	}
	for _, target := range []string{systemLinkPath, filepath.Join(c.userBinDir(), "termote")} {
		created, err := c.symlink(source, target)
		if err != nil {
			continue
		}
		if created {
			c.infof("Created symlink: %s -> %s", target, source)
		} else {
			c.infof("Already linked: %s -> %s", target, source)
		}
		c.checkPath(filepath.Dir(target))
		return nil
	}
	c.warnf("Cannot create symlink (no write permission). Run:")
	fmt.Fprintf(c.out, "  sudo ln -sf %q %s\n", source, systemLinkPath)
	return nil
}

// symlink points target at source, replacing an older termote symlink but
// never a regular file. It reports created=false with no error when target
// already pointed at source.
func (c *cli) symlink(source, target string) (bool, error) {
	if st, err := os.Lstat(target); err == nil {
		if st.Mode()&os.ModeSymlink == 0 {
			return false, fmt.Errorf("%s exists and is not a symlink", target)
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

// checkPath warns when dir is not on PATH.
func (c *cli) checkPath(dir string) {
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if strings.EqualFold(filepath.Clean(p), filepath.Clean(dir)) {
			c.infof("You can now run 'termote' from anywhere")
			return
		}
	}
	c.warnf("%s is not in PATH", dir)
	if c.goos == "windows" {
		fmt.Fprintf(c.out, "Add it permanently:\n  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';%s', 'User')\n", dir)
		if c.interactive && !strings.HasPrefix(strings.ToLower(c.prompt("Add to PATH now? [Y/n]: ")), "n") {
			script := "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';" +
				strings.ReplaceAll(dir, "'", "''") + "', 'User')"
			if err := c.run.Run("", nil, "powershell", "-NoProfile", "-Command", script); err != nil {
				c.warnf("Could not update PATH: %v", err)
			} else {
				c.infof("Added to PATH. Open a new terminal to use 'termote'.")
			}
		}
		return
	}
	fmt.Fprintf(c.out, "Add to ~/.bashrc or ~/.zshrc:\n  export PATH=\"%s:$PATH\"\n", dir)
}

func (c *cli) windowsLinkFiles() (cmdFile, legacyPS1 string) {
	return filepath.Join(c.userBinDir(), "termote.cmd"), filepath.Join(c.userBinDir(), "termote.ps1")
}

// linkWindows writes ~/.local/bin/termote.cmd calling the shim. 0.x also
// copied termote.ps1 there; that copy would now look for the binary next to
// itself, so it is removed.
func (c *cli) linkWindows() error {
	cmdFile, legacy := c.windowsLinkFiles()
	source := c.shimPath()
	if err := os.MkdirAll(c.userBinDir(), 0o755); err != nil {
		return err
	}
	if isLegacyScriptCopy(legacy) {
		if err := os.Remove(legacy); err == nil {
			c.infof("Removed old copy: %s", legacy)
		}
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

// isLegacyScriptCopy recognises the termote.ps1 copy 0.x `link` made.
func isLegacyScriptCopy(path string) bool {
	b, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(b), "Termote CLI")
}

func (c *cli) cmdUnlink() error {
	var targets []string
	if c.goos == "windows" {
		cmdFile, legacy := c.windowsLinkFiles()
		targets = []string{cmdFile, legacy}
	} else {
		targets = []string{systemLinkPath, filepath.Join(c.userBinDir(), "termote")}
	}
	removed := false
	for _, t := range targets {
		st, err := os.Lstat(t)
		if err != nil {
			continue
		}
		// On Unix only a symlink to a termote.sh is ours to remove.
		if c.goos != "windows" {
			cur, _ := os.Readlink(t)
			if st.Mode()&os.ModeSymlink == 0 || filepath.Base(cur) != "termote.sh" {
				continue
			}
		}
		if err := os.Remove(t); err != nil {
			if errors.Is(err, os.ErrPermission) {
				c.warnf("Cannot remove %s (no write permission). Run: sudo rm %s", t, t)
			} else {
				c.warnf("Cannot remove %s: %v", t, err)
			}
			continue
		}
		c.infof("Removed: %s", t)
		removed = true
	}
	if !removed {
		c.infof("No link found")
		return nil
	}
	c.infof("To restore: %s link", c.shimPath())
	return nil
}
