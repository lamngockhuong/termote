package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// allowPathEnv is what an allowed path (a Place in Files) is checked
// against: start, container up and serve build it for their own user.
type allowPathEnv struct {
	home string
	// deny are directories a Place may not be, lie in or contain: the
	// user's keys, termote's own dirs and the system ones.
	deny []string
	// isGitDir reports a git directory or a bare repository; nil skips it.
	isGitDir func(dir string) bool
}

// newAllowPathEnv builds the env for home and termote's own dirs; ~/.ssh,
// ~/.gnupg, systemDenyDirs and the dirs holding sockets that control the host
// (allowPathSocketDirs, from getenv) are always added.
func newAllowPathEnv(home string, getenv func(string) string, termoteDirs ...string) allowPathEnv {
	dirs := slices.Clone(termoteDirs)
	if home != "" {
		dirs = append(dirs, filepath.Join(home, ".ssh"), filepath.Join(home, ".gnupg"))
	}
	dirs = append(dirs, systemDenyDirs...)
	dirs = append(dirs, allowPathSocketDirs(getenv)...)
	return allowPathEnv{home: home, deny: filesDenyDirs(dirs...), isGitDir: gitDirProbe(newGitRunner())}
}

// allowPathEnv is the env of the CLI's user: termote's config, state, data
// and cache (trash, uploads) dirs.
func (c *cli) allowPathEnv() allowPathEnv {
	return newAllowPathEnv(c.home, c.getenv, c.configDir(), c.stateDir(), c.dataDir(),
		filepath.Join(c.cacheDir(), "termote"))
}

// allowPathSocketDirs are where the host's control sockets live (tmux and
// Herdr in /tmp or $TMPDIR, docker.sock under /run, the user's runtime dir):
// mounted in the container, a Place there would let a terminal drive the
// host. Windows uses named pipes. A variable: tests, whose temp dirs are
// under /tmp, replace it.
var allowPathSocketDirs = defaultSocketDirs

func defaultSocketDirs(getenv func(string) string) []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	dirs := []string{"/tmp", "/run", "/var/run", os.TempDir()}
	if getenv != nil {
		if d := getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(d) {
			dirs = append(dirs, d)
		}
	}
	return dirs
}

// gitDirProbe asks git whether dir is a git directory or a bare repository,
// through the gitRunner (no hook, filter or fsmonitor runs). A dir git does
// not know as a repo, or no git at all, is not one.
func gitDirProbe(g *gitRunner) func(string) bool {
	return func(dir string) bool {
		ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
		defer cancel()
		out, _, err := g.output(ctx, gitCall{root: dir, safeDir: dir, limit: 4096},
			"rev-parse", "--is-inside-git-dir", "--is-bare-repository")
		return err == nil && slices.Contains(strings.Fields(string(out)), "true")
	}
}

// errAllowPathChars: the path could not be saved in the config line.
var errAllowPathChars = errors.New("holds a quote, a line break or NUL")

// validateAllowPath refuses a folder Files must never serve as a Place: one
// that is missing, the home directory or above it, at, inside or above a
// denied directory, or a git directory. The path as given and its resolved
// form are both checked, so a symlink cannot lead into a refused one. The
// error is the reason alone; allowPathError adds the path.
func validateAllowPath(p string, env allowPathEnv) error {
	if strings.ContainsAny(p, "\x00\"\n\r") {
		return errAllowPathChars
	}
	if env.home == "" {
		return errors.New("cannot tell where your home directory is")
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		return errors.New("not a directory")
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return errors.New("not a directory")
	}
	forms := []string{filepath.Clean(p)}
	if real = filepath.Clean(real); real != forms[0] {
		forms = append(forms, real)
	}
	homes := filesDenyDirs(env.home)
	for _, f := range forms {
		if filepath.Dir(f) == f || slices.ContainsFunc(homes, func(h string) bool { return underDir(f, h) }) {
			return errors.New("is your home directory or contains it; allow a folder inside it instead")
		}
		for _, d := range env.deny {
			if underDir(d, f) || underDir(f, d) {
				return fmt.Errorf("is, is inside, or contains %s, which termote never serves", d)
			}
		}
		rest := strings.TrimPrefix(f, filepath.VolumeName(f))
		if slices.ContainsFunc(strings.Split(filepath.ToSlash(rest), "/"), isGitDirName) {
			return errors.New("is a git directory")
		}
	}
	if env.isGitDir != nil && env.isGitDir(real) {
		return errors.New("is a git directory")
	}
	return nil
}

// allowPathError puts the path in front of validateAllowPath's reason.
func allowPathError(p string, err error) error {
	if errors.Is(err, errAllowPathChars) {
		return fmt.Errorf("invalid --allow-path %q: %v", p, err)
	}
	return fmt.Errorf("--allow-path %s: %v", p, err)
}

// normalizeAllowPath makes a --allow-path or --remove-path value absolute
// and clean, spelled as the disk spells it, which is the form saved.
func normalizeAllowPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("--allow-path needs a directory")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return diskSpelling(abs), nil
}

// normalizeAllowPaths normalizes each flag value.
func normalizeAllowPaths(in []string) ([]string, error) {
	var out []string
	for _, p := range in {
		n, err := normalizeAllowPath(p)
		if err != nil {
			return nil, usageError("%v", err)
		}
		out = append(out, n)
	}
	return out, nil
}

// sameAllowPath compares two saved paths the way underDir compares names.
func sameAllowPath(a, b string) bool { return a == b || underDir(a, b) && underDir(b, a) }

// mergePaths returns saved plus added minus removed, sorted, each once.
func mergePaths(saved, added, removed []string) []string {
	out := slices.Clone(added)
	for _, p := range saved {
		if !slices.ContainsFunc(out, func(q string) bool { return sameAllowPath(p, q) }) {
			out = append(out, p)
		}
	}
	out = slices.DeleteFunc(out, func(p string) bool {
		return slices.ContainsFunc(removed, func(r string) bool { return sameAllowPath(r, p) })
	})
	slices.Sort(out)
	return slices.Compact(out)
}

// checkAllowPaths refuses a new path that fails validation (nothing is saved
// then), and reports a saved one that does with the command removing it
// (cmd: "start" or "container up"): it stays saved and is not served. paths
// is the merged list, added the paths of this command line; extra checks
// what the command needs on top. It returns the paths that pass.
func (c *cli) checkAllowPaths(paths, added []string, cmd string, extra func(string) error) ([]string, error) {
	env := c.allowPathEnv()
	check := func(p string) error {
		if err := validateAllowPath(p, env); err != nil {
			return err
		}
		if extra != nil {
			return extra(p)
		}
		return nil
	}
	for _, p := range added {
		if err := check(p); err != nil {
			return nil, usageError("%v", allowPathError(p, err))
		}
		if err := c.savablePath(p); err != nil {
			return nil, usageError("%v", err)
		}
	}
	var ok []string
	for _, p := range paths {
		if slices.ContainsFunc(added, func(a string) bool { return sameAllowPath(a, p) }) {
			ok = append(ok, p)
			continue
		}
		if err := check(p); err != nil {
			c.warnf("Allowed path skipped: %s: %v (remove it with: termote %s --remove-path %s)", p, err, cmd, p)
			continue
		}
		ok = append(ok, p)
	}
	return ok, nil
}

// unknownRemovedPaths says which --remove-path names no saved folder.
func (c *cli) unknownRemovedPaths(saved, removed []string) {
	for _, r := range removed {
		if !slices.ContainsFunc(saved, func(p string) bool { return sameAllowPath(p, r) }) {
			c.infof("--remove-path %s: not an allowed path, nothing to remove", r)
		}
	}
}

// savablePath refuses a path the Unix config cannot hold: its list is
// ':'-separated. Windows saves JSON, and its paths always hold ':'.
func (c *cli) savablePath(p string) error {
	if c.goos != "windows" && strings.Contains(p, ":") {
		return fmt.Errorf("--allow-path %s: ':' cannot be saved in the config on this system", p)
	}
	return nil
}

// splitPaths reads a ':'-separated path list of the Unix config.
func splitPaths(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ":") {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
