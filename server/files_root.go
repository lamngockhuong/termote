package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// PaneDirer is implemented by backends that can tell a pane's working
// directory. It is not part of Mux: a backend without it answers 501 on the
// files routes.
type PaneDirer interface {
	// PaneDir returns the pane's working directory and a key that names the
	// pane for as long as it lives (tmux "%N", herdr pane id), unlike a tmux
	// window index, which is reused.
	PaneDir(ctx context.Context, paneID string) (dir, stableKey string, err error)
}

const (
	// gitTimeout bounds one git command. Longer than muxTimeout: git status
	// on a large repo is slow, and the reply is cached for every client.
	gitTimeout = 10 * time.Second
	// gitMaxRunning caps the git processes the server runs at once.
	gitMaxRunning = 2
	// gitFailBackoff: after a timeout, git is not run again in that root for
	// this long, so every polling client backs off together.
	gitFailBackoff = 30 * time.Second
	// filesRootTTL caches what a directory resolves to and the filter
	// drivers of a root.
	filesRootTTL = 2 * time.Second
	// rootSettle: a pane's new directory replaces its root only once two
	// resolves at least this far apart agree, since #{pane_current_path}
	// follows the foreground process (`make -C x`).
	rootSettle = 2 * time.Second
	// rootStateIdle: the settle state of a pane not asked for this long is
	// dropped.
	rootStateIdle = 10 * time.Minute
	gitStderrMax  = 4096
)

var (
	errGitTimeout       = errors.New("git timed out")
	errDirNotAvailable  = inputError("directory not available")
	errUnsafeRepoConfig = errors.New("repository config defines a filter driver that cannot be disabled")
)

// filesRoot is what a pane's directory resolves to.
type filesRoot struct {
	Root   string
	IsRepo bool
	// SafeDir is passed as safe.directory to every git command in Root: git
	// refused the repo for its owner, and the server decided to trust it.
	SafeDir string
	// GitDir is the repo's git directory, never served: it is not always a
	// .git inside Root (--separate-git-dir).
	GitDir string
}

// gitRunner is the only place the server runs git. Every command gets a
// filtered environment, config overrides that keep a repo's own config from
// running programs, a timeout and a slot of a server-wide semaphore.
type gitRunner struct {
	bin     string
	timeout time.Duration
	sem     chan struct{}
	filters *ttlCache[[]string]

	mu       sync.Mutex
	failedAt map[string]time.Time // root → last timeout
}

func newGitRunner() *gitRunner {
	return &gitRunner{
		bin:      "git",
		timeout:  gitTimeout,
		sem:      make(chan struct{}, gitMaxRunning),
		filters:  newTTLCache[[]string](filesRootTTL),
		failedAt: map[string]time.Time{},
	}
}

// gitCall describes one git command.
type gitCall struct {
	root    string
	safeDir string
	// noFilters: a filter driver of the repo would run (status, diff), so
	// every one defined in its config is disabled first.
	noFilters bool
	// limit caps stdout; more sets truncated. 0 means 1 MiB.
	limit int64
	// heavy: a command whose cost grows with the repo (status, diff). It
	// takes a slot of the semaphore, and a timeout backs the root off.
	// Light ones (rev-parse, config) do neither, so a slow status never
	// holds up resolving or browsing a root.
	heavy bool
	// stdin is fed to git (cat-file --batch); nil gives it none.
	stdin []byte
}

// gitEnv is the server environment without anything that configures git or
// carries a Termote secret. Windows keys are case-insensitive.
func gitEnv() []string {
	drop := []string{"LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES"}
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if isTermoteEnv(kv) || len(k) >= 4 && strings.EqualFold(k[:4], "GIT_") || containsFold(drop, k) {
			continue
		}
		env = append(env, kv)
	}
	// GIT_NO_LAZY_FETCH: a partial clone would otherwise fetch a missing
	// object from its promisor remote, running the repo's core.sshCommand.
	// An empty GIT_ALLOW_PROTOCOL allows no transport whatever the config
	// says, so a git older than GIT_NO_LAZY_FETCH (2.44) fetches nothing
	// either.
	return append(env, "LANG=C", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_NO_LAZY_FETCH=1", "GIT_ALLOW_PROTOCOL=")
}

func containsFold(list []string, s string) bool {
	for _, v := range list {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}

// argv builds the full git command line. Overrides go through -c, so they
// win over every config file of the repo.
func (g *gitRunner) argv(c gitCall, filters []string, args []string) []string {
	// protocol.allow=never: no transport by default. It does not override
	// a protocol.<name>.allow of the repo's own config, which is why
	// gitEnv also sets an empty GIT_ALLOW_PROTOCOL. -c settings reach any
	// git git runs itself.
	// core.hooksPath to the null device: no hook of the repo runs (diff
	// refreshing the index would run post-index-change), and
	// diff.autoRefreshIndex=false keeps diff from writing the index at all.
	argv := []string{"-C", c.root, "--no-pager",
		"-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never",
		"-c", "core.hooksPath=" + os.DevNull, "-c", "diff.autoRefreshIndex=false"}
	if c.safeDir != "" {
		argv = append(argv, "-c", "safe.directory="+c.safeDir)
	}
	for _, f := range filters {
		argv = append(argv,
			"-c", "filter."+f+".clean=",
			"-c", "filter."+f+".smudge=",
			"-c", "filter."+f+".process=",
			"-c", "filter."+f+".required=false")
	}
	return append(argv, args...)
}

// filterDrivers lists the filter drivers the repo's config defines (includes
// followed). Reading config runs nothing. A driver name -c cannot express
// fails closed.
func (g *gitRunner) filterDrivers(ctx context.Context, c gitCall) ([]string, error) {
	// The result is shared: it must not fail because the first caller left.
	ctx = context.WithoutCancel(ctx)
	return g.filters.do(c.root+"\x00"+c.safeDir, func() ([]string, error) {
		out, _, err := g.exec(ctx, gitCall{root: c.root, safeDir: c.safeDir, limit: 1 << 20},
			nil, "config", "-z", "--name-only", "--get-regexp", `^filter\.`)
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return nil, nil // no match
		}
		if err != nil {
			return nil, err
		}
		return parseFilterDrivers(out)
	})
}

// parseFilterDrivers takes `git config -z --name-only` output: keys like
// "filter.<driver>.clean", the driver possibly containing dots.
func parseFilterDrivers(out []byte) ([]string, error) {
	seen := map[string]bool{}
	var drivers []string
	for _, key := range strings.Split(string(out), "\x00") {
		key = strings.TrimSpace(key)
		rest, ok := strings.CutPrefix(key, "filter.")
		i := strings.LastIndexByte(rest, '.')
		if !ok || i <= 0 {
			continue
		}
		d := rest[:i]
		// -c splits key from value at the first '='.
		if strings.ContainsAny(d, "=\n\x00") {
			return nil, errUnsafeRepoConfig
		}
		if !seen[d] {
			seen[d] = true
			drivers = append(drivers, d)
		}
	}
	return drivers, nil
}

// output runs git in c.root and returns its stdout, cut at c.limit.
func (g *gitRunner) output(ctx context.Context, c gitCall, args ...string) ([]byte, bool, error) {
	if c.heavy && g.backingOff(c.root) {
		return nil, false, errGitTimeout
	}
	var filters []string
	if c.noFilters {
		f, err := g.filterDrivers(ctx, c)
		if err != nil {
			return nil, false, err
		}
		filters = f
	}
	return g.exec(ctx, c, filters, args...)
}

func (g *gitRunner) backingOff(root string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	at, ok := g.failedAt[root]
	if ok && time.Since(at) >= gitFailBackoff {
		delete(g.failedAt, root)
		ok = false
	}
	return ok
}

func (g *gitRunner) exec(ctx context.Context, c gitCall, filters []string, args ...string) ([]byte, bool, error) {
	if c.heavy {
		wait, cancelWait := context.WithTimeout(ctx, g.timeout)
		defer cancelWait()
		select {
		case g.sem <- struct{}{}:
		case <-wait.Done():
			return nil, false, errGitTimeout
		}
		defer func() { <-g.sem }()
	}

	run, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	cmd := exec.CommandContext(run, g.bin, g.argv(c, filters, args)...)
	cmd.Env = gitEnv()
	cmd.Dir = c.root
	if c.stdin != nil {
		cmd.Stdin = bytes.NewReader(c.stdin)
	}
	// A child that outlives git (it should not have any) must not hold the
	// pipes open past the timeout.
	cmd.WaitDelay = time.Second
	limit := c.limit
	if limit <= 0 {
		limit = 1 << 20
	}
	stdout := &capWriter{limit: limit, full: cancel}
	var stderr bytes.Buffer
	cmd.Stdout = stdout
	cmd.Stderr = &limitedWriter{w: &stderr, n: gitStderrMax}
	err := cmd.Run()
	if stdout.truncated {
		// git was stopped because the rest is not wanted.
		return stdout.buf.Bytes(), true, nil
	}
	if errors.Is(run.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		if c.heavy {
			g.mu.Lock()
			g.failedAt[c.root] = time.Now()
			g.mu.Unlock()
		}
		log.Printf("git %s in %s: timed out after %s", strings.Join(args, " "), c.root, g.timeout)
		return nil, false, errGitTimeout
	}
	if err != nil {
		return stdout.buf.Bytes(), false, &gitError{err: err, stderr: stderr.String()}
	}
	return stdout.buf.Bytes(), false, nil
}

// capWriter keeps the first limit bytes and calls full once more arrive.
type capWriter struct {
	buf       bytes.Buffer
	limit     int64
	truncated bool
	full      func()
}

func (w *capWriter) Write(p []byte) (int, error) {
	if room := w.limit - int64(w.buf.Len()); int64(len(p)) > room {
		w.buf.Write(p[:max(room, 0)])
		if !w.truncated {
			w.truncated = true
			w.full()
		}
		return len(p), nil
	}
	return w.buf.Write(p)
}

// gitError keeps git's stderr for the server log and for the checks below;
// it is never sent to a client.
type gitError struct {
	err    error
	stderr string
}

func (e *gitError) Error() string { return e.err.Error() + ": " + strings.TrimSpace(e.stderr) }
func (e *gitError) Unwrap() error { return e.err }

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

// rootResolver turns a pane's directory into its files root.
type rootResolver struct {
	git      *gitRunner
	resolved *ttlCache[filesRoot] // directory → root
	// inContainer and ownedByServer are replaced by tests.
	inContainer   func() bool
	ownedByServer func(path string) bool

	mu    sync.Mutex
	panes map[string]*paneRootState // stableKey → settle state
	now   func() time.Time
}

type paneRootState struct {
	cur       filesRoot
	next      filesRoot
	nextSince time.Time // when next was first seen
	used      time.Time
}

func newRootResolver(git *gitRunner) *rootResolver {
	return &rootResolver{
		git:           git,
		resolved:      newTTLCache[filesRoot](filesRootTTL),
		inContainer:   runningInContainer,
		ownedByServer: ownedByServer,
		panes:         map[string]*paneRootState{},
		now:           time.Now,
	}
}

// paneRoot resolves the root of a pane and keeps it stable while the pane's
// directory only passes through another one.
func (rr *rootResolver) paneRoot(ctx context.Context, d PaneDirer, paneID string) (filesRoot, error) {
	dir, key, err := d.PaneDir(ctx, paneID)
	if err != nil {
		return filesRoot{}, err
	}
	root, err := rr.resolve(ctx, dir)
	if err != nil {
		return filesRoot{}, err
	}
	return rr.settle(key, root), nil
}

func (rr *rootResolver) settle(key string, root filesRoot) filesRoot {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	now := rr.now()
	for k, s := range rr.panes {
		if now.Sub(s.used) >= rootStateIdle {
			delete(rr.panes, k)
		}
	}
	s, ok := rr.panes[key]
	if !ok {
		rr.panes[key] = &paneRootState{cur: root, used: now}
		return root
	}
	s.used = now
	switch {
	case root == s.cur:
		s.next = filesRoot{}
	case root != s.next:
		s.next, s.nextSince = root, now
	case now.Sub(s.nextSince) >= rootSettle:
		s.cur, s.next = root, filesRoot{}
	}
	return s.cur
}

// resolve returns the git toplevel of dir, or dir itself outside a repo.
func (rr *rootResolver) resolve(ctx context.Context, dir string) (filesRoot, error) {
	// Shared by every client asking for dir: a client that leaves must not
	// turn the repo into a plain directory for the others.
	ctx = context.WithoutCancel(ctx)
	return rr.resolved.do(dir, func() (filesRoot, error) {
		abs, err := filepath.Abs(dir)
		if err == nil {
			abs, err = filepath.EvalSymlinks(abs)
		}
		if err != nil {
			return filesRoot{}, errDirNotAvailable
		}
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			return filesRoot{}, errDirNotAvailable
		}
		top, gitDir, err := rr.toplevel(ctx, abs, "")
		var ge *gitError
		if errors.As(err, &ge) {
			if owned, ok := dubiousRepo(ge.stderr); ok {
				if !rr.trustRepo(owned) {
					log.Printf("files: %s not trusted by git (owner differs), browsing it as a plain directory", owned)
					return filesRoot{Root: abs}, nil
				}
				top, gitDir, err = rr.toplevel(ctx, abs, owned)
				if err == nil {
					return rootFromToplevel(abs, top, gitDir, owned), nil
				}
			}
		}
		switch {
		case err == nil:
			return rootFromToplevel(abs, top, gitDir, ""), nil
		case errors.As(err, &ge), errors.Is(err, exec.ErrNotFound):
			// Not a repo, or no git: the directory itself.
			return filesRoot{Root: abs}, nil
		default:
			return filesRoot{}, err
		}
	})
}

// toplevel returns the work tree and the git directory of the repo dir is in.
func (rr *rootResolver) toplevel(ctx context.Context, dir, safeDir string) (top, gitDir string, err error) {
	out, _, err := rr.git.output(ctx, gitCall{root: dir, safeDir: safeDir, limit: 64 << 10},
		"rev-parse", "--show-toplevel", "--absolute-git-dir")
	if err != nil {
		return "", "", err
	}
	top, gitDir, _ = strings.Cut(strings.TrimRight(string(out), "\r\n"), "\n")
	return strings.TrimRight(top, "\r"), gitDir, nil
}

// rootFromToplevel turns git's toplevel into the root, or dir itself when
// the toplevel is not a work tree holding the repo: core.worktree can name
// any directory (even /), but a real one (a clone, a linked worktree, a
// submodule, --separate-git-dir) always has a .git entry at its top.
func rootFromToplevel(dir, top, gitDir, safeDir string) filesRoot {
	clean := func(p string) string {
		if p == "" {
			return ""
		}
		p = filepath.Clean(filepath.FromSlash(p))
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		return p
	}
	top, gitDir = clean(top), clean(gitDir)
	if top == "" || top == "." || !underDir(top, dir) {
		return filesRoot{Root: dir}
	}
	if !gitEntryLeadsTo(top, gitDir) {
		log.Printf("files: %s has %s as its work tree, browsing it as a plain directory", dir, top)
		return filesRoot{Root: dir}
	}
	return filesRoot{Root: top, IsRepo: true, SafeDir: safeDir, GitDir: gitDir}
}

// gitEntryLeadsTo reports whether top's .git is gitDir: that directory, or a
// gitfile ("gitdir: <path>", relative to top) naming it. A .git of another
// repo (core.worktree pointing at a parent with a repo of its own, such as
// a home directory under dotfiles) does not count.
func gitEntryLeadsTo(top, gitDir string) bool {
	entry := filepath.Join(top, ".git")
	fi, err := os.Lstat(entry)
	if err != nil {
		return false
	}
	target := entry
	if fi.Mode().IsRegular() {
		f, err := os.Open(entry)
		if err != nil {
			return false
		}
		b, _ := io.ReadAll(io.LimitReader(f, 4096))
		f.Close()
		p, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
		if !ok {
			return false
		}
		target = filepath.FromSlash(strings.TrimSpace(p))
		if !filepath.IsAbs(target) {
			target = filepath.Join(top, target)
		}
	}
	if r, err := filepath.EvalSymlinks(target); err == nil {
		target = r
	}
	target = filepath.Clean(target)
	return underDir(target, gitDir) && underDir(gitDir, target)
}

// trustRepo decides whether to pass safe.directory for a repo git refused
// for its owner: only when the server's own user owns it, or inside the
// container for the mounted workspace (the host user's uid differs).
func (rr *rootResolver) trustRepo(path string) bool {
	if rr.ownedByServer(path) {
		return true
	}
	if !rr.inContainer() {
		return false
	}
	rel, err := filepath.Rel("/workspace", path)
	return err == nil && filepath.IsLocal(rel)
}

// dubiousRepo extracts the repository path from git's "detected dubious
// ownership in repository at '<path>'" error (messages are in English: LC_ALL=C).
func dubiousRepo(stderr string) (string, bool) {
	const marker = "dubious ownership in repository at '"
	i := strings.Index(stderr, marker)
	if i < 0 {
		return "", false
	}
	rest := stderr[i+len(marker):]
	j := strings.Index(rest, "'\n")
	if j < 0 {
		j = strings.LastIndexByte(rest, '\'')
	}
	if j <= 0 {
		return "", false
	}
	return filepath.Clean(filepath.FromSlash(rest[:j])), true
}

// runningInContainer reports whether the server runs in a docker or podman
// container.
func runningInContainer() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	for _, p := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}
