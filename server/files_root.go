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
	"slices"
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

// paneOutputDirer is a PaneDirer whose directory can be what the pane printed
// rather than a process's: psmux 3.4 takes OSC 7 / OSC 9;9 while ssh.exe or
// wsl.exe runs in the pane, so a remote host can name \\host\share.
type paneOutputDirer interface {
	dirFromPaneOutput() bool
}

// mayBeFromPaneOutput reports whether d's directories are checked as ones
// a pane could announce: every backend's on Windows, where only such a path
// (a UNC one) reaches another host, and elsewhere a paneOutputDirer's.
func mayBeFromPaneOutput(d PaneDirer) bool {
	if runtime.GOOS == "windows" {
		return true
	}
	od, ok := d.(paneOutputDirer)
	return ok && od.dirFromPaneOutput()
}

const (
	// gitTimeout bounds one git command. Longer than muxTimeout: git status
	// on a large repo is slow, and the reply is cached for every client.
	gitTimeout = 10 * time.Second
	// gitWriteTimeout bounds a command that writes the index: it never
	// ends with the request (gitCall.write).
	gitWriteTimeout = 30 * time.Second
	// gitMaxRunning caps the git processes the server runs at once.
	gitMaxRunning = 2
	// gitFailBackoff: after a timeout, git is not run again in that root for
	// this long, so every polling client backs off together.
	gitFailBackoff = 30 * time.Second
	// filesRootTTL caches what a directory resolves to and the filter
	// drivers and hooks a root's config defines.
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
	errGitTimeout = errors.New("git timed out")
	// errGitBusy: a tryOnly command found every slot taken.
	errGitBusy          = errors.New("git busy")
	errDirNotAvailable  = inputError("directory not available")
	errUnsafeRepoConfig = errors.New("repository config defines a filter driver or hook that cannot be disabled")
	errNoHooksDir       = errors.New("no empty hooks directory for git")
)

// noHooksDir is the core.hooksPath every Files git command runs with: an
// empty directory termote owns, by absolute path. Not the null device: on
// Windows that is NUL, a relative path git resolves against the worktree,
// where a repository can ship NUL/post-index-change. Made at first use
// under the user's cache dir; tests point it at a temporary one.
var noHooksDir = sync.OnceValues(func() (string, error) {
	cache, err := os.UserCacheDir()
	if err == nil {
		cache, err = makeNoHooksDir(filepath.Join(cache, "termote", "no-hooks"))
	}
	if err != nil {
		log.Printf("files: git disabled: %v", err)
	}
	return cache, err
})

// makeNoHooksDir creates dir (0700) and checks it is absolute, a real
// directory the server user owns and empty, so no hook can be found in it.
func makeNoHooksDir(dir string) (string, error) {
	if !filepath.IsAbs(dir) {
		return "", errors.New("hooks directory is not absolute")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return "", errors.New("hooks directory is not a directory")
	}
	if err := checkPrivateDir(dir); err != nil {
		return "", err
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) > 0 {
		return "", errors.New("hooks directory is not empty")
	}
	return dir, nil
}

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
	// Dir is the pane's directory, resolved, set by paneRoot (the agent
	// commands route reads the skill dirs on the way down to it). It settles
	// with the root, so a foreground process passing through another dir does
	// not move it either.
	Dir string
}

// gitRunner is the only place the server runs git. Every command gets a
// filtered environment, config overrides that keep a repo's own config from
// running programs, a timeout and a slot of a server-wide semaphore.
type gitRunner struct {
	bin          string
	timeout      time.Duration
	writeTimeout time.Duration
	sem          chan struct{}
	overrides    *ttlCache[repoOverrides]
	// windows: argv empties core.excludesFile and core.attributesFile;
	// runtime.GOOS == "windows", which tests replace.
	windows bool

	mu       sync.Mutex
	failedAt map[string]time.Time // root → last timeout
	// rootSlots: the heavy command each root runs, at most one at a time
	// (a write aside), so a root whose git waits on something (a FIFO deep
	// in its tree) holds one slot of sem and never all of them.
	rootSlots map[string]*rootSlot
}

// rootSlot is the one heavy command a root may run, and how many calls hold
// or wait for it.
type rootSlot struct {
	ch    chan struct{}
	users int
}

// takeRootSlot waits until no other heavy command runs in root, at most
// until wait is done, or with a nil wait only takes the slot when it is
// free; release gives the slot back.
func (g *gitRunner) takeRootSlot(wait context.Context, root string) (release func(), ok bool) {
	g.mu.Lock()
	if g.rootSlots == nil {
		g.rootSlots = map[string]*rootSlot{}
	}
	s := g.rootSlots[root]
	if s == nil {
		s = &rootSlot{ch: make(chan struct{}, 1)}
		g.rootSlots[root] = s
	}
	s.users++
	g.mu.Unlock()
	done := func() {
		g.mu.Lock()
		if s.users--; s.users == 0 {
			delete(g.rootSlots, root)
		}
		g.mu.Unlock()
	}
	var waited <-chan struct{} // nil: never ready
	if wait != nil {
		waited = wait.Done()
	}
	select {
	case s.ch <- struct{}{}:
		return func() { <-s.ch; done() }, true
	default:
	}
	if wait != nil {
		select {
		case s.ch <- struct{}{}:
			return func() { <-s.ch; done() }, true
		case <-waited:
		}
	}
	done()
	return nil, false
}

func newGitRunner() *gitRunner {
	return &gitRunner{
		bin:          "git",
		timeout:      gitTimeout,
		writeTimeout: gitWriteTimeout,
		sem:          make(chan struct{}, gitMaxRunning),
		overrides:    newTTLCache[repoOverrides](filesRootTTL),
		failedAt:     map[string]time.Time{},
		windows:      runtime.GOOS == "windows",
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
	// noBackoff: a heavy command whose timeout does not back the root off
	// (find lists files, and a huge untracked tree must not fail Changes).
	noBackoff bool
	// tryOnly: a heavy command that runs only when a slot stays free after
	// it takes one, and never waits (errGitBusy), so a background read
	// never holds up a client's.
	tryOnly bool
	// stdin is fed to git (cat-file --batch); nil gives it none.
	stdin []byte
	// write: the command writes the index (add, apply --cached, restore
	// --staged, reset). It runs to its end even when the request ends, under
	// gitWriteTimeout, and is interrupted rather than killed on Unix, so git
	// removes its index.lock itself.
	write bool
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

// repoOverrides names what the repo's config defines that would run a
// program, for argv to turn off one by one.
type repoOverrides struct {
	// filters: the filter drivers (filter.<driver>.*), turned off when
	// gitCall.noFilters.
	filters []string
	// hooks: the hooks defined in config (hook.<name>.*), which
	// core.hooksPath does not reach, turned off for every command.
	hooks []string
}

// argv builds the full git command line. Overrides go through -c, so they
// win over every config file of the repo.
func (g *gitRunner) argv(c gitCall, o repoOverrides, hooksDir string, args []string) []string {
	// protocol.allow=never: no transport by default. It does not override
	// a protocol.<name>.allow of the repo's own config, which is why
	// gitEnv also sets an empty GIT_ALLOW_PROTOCOL. -c settings reach any
	// git git runs itself.
	// core.hooksPath to an empty directory (noHooksDir): no hook file of
	// the repo runs (diff refreshing the index would run
	// post-index-change), and
	// diff.autoRefreshIndex=false keeps diff from writing the index at all.
	// A hook defined in config runs whatever core.hooksPath says (git 2.54
	// and later): hook.<name>.enabled=false turns each one off, and a git
	// without such hooks ignores the setting.
	argv := []string{"-C", c.root, "--no-pager",
		"-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never",
		"-c", "core.hooksPath=" + hooksDir, "-c", "diff.autoRefreshIndex=false"}
	// On Windows core.excludesFile and core.attributesFile are emptied, a
	// second layer behind repoConfigRefused: git status opens either file
	// wherever the repository's config points it, and a share sends that
	// host the user's NTLM hash. Empty means no file at all, not the default
	// one, so the user's global ignore and attributes files do not apply
	// there either; the repository's own files still do.
	if g.windows {
		argv = append(argv, "-c", "core.excludesFile=", "-c", "core.attributesFile=")
	}
	if c.safeDir != "" {
		argv = append(argv, "-c", "safe.directory="+c.safeDir)
	}
	for _, h := range o.hooks {
		argv = append(argv, "-c", "hook."+h+".enabled=false")
	}
	for _, f := range o.filters {
		argv = append(argv,
			"-c", "filter."+f+".clean=",
			"-c", "filter."+f+".smudge=",
			"-c", "filter."+f+".process=",
			"-c", "filter."+f+".required=false")
	}
	return append(argv, args...)
}

// repoOverrides lists the filter drivers and hooks the repo's config
// defines (includes followed), or the user's config outside a repo. Reading
// config runs nothing. A name -c cannot express fails closed; a config git
// cannot read fails the command with git's own error, which the command
// itself would have met (a repo owned by another user, a broken file).
func (g *gitRunner) repoOverrides(ctx context.Context, c gitCall) (repoOverrides, error) {
	// The result is shared: it must not fail because the first caller left.
	ctx = context.WithoutCancel(ctx)
	load := func() (repoOverrides, error) {
		out, _, err := g.exec(ctx, gitCall{root: c.root, safeDir: c.safeDir, limit: 1 << 20},
			repoOverrides{}, "config", "-z", "--name-only", "--get-regexp", `^(filter|hook)\.`)
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return repoOverrides{}, nil // no match
		}
		if err != nil {
			return repoOverrides{}, err
		}
		return parseRepoOverrides(out)
	}
	// A command that would run a filter or a hook reads the list afresh: a
	// config include can name a file a checkout has just written (a new
	// worktree's branch, a branch switched to), and a list read before it
	// would leave that file's filter on for as long as it is cached.
	if c.noFilters || c.write {
		return load()
	}
	return g.overrides.do(c.root+"\x00"+c.safeDir, load)
}

// parseRepoOverrides takes `git config -z --name-only` output: keys like
// "filter.<driver>.clean" or "hook.<name>.command", the name possibly
// containing dots or empty ([hook ""] runs like any other). A key with no
// subsection at all (hook.jobs) names nothing.
func parseRepoOverrides(out []byte) (repoOverrides, error) {
	var o repoOverrides
	seen := map[string]bool{}
	for _, key := range strings.Split(string(out), "\x00") {
		key = strings.TrimSpace(key)
		section, rest, _ := strings.Cut(key, ".")
		i := strings.LastIndexByte(rest, '.')
		if i < 0 {
			continue
		}
		name := rest[:i]
		var list *[]string
		switch strings.ToLower(section) {
		case "filter":
			list = &o.filters
		case "hook":
			list = &o.hooks
		default:
			continue
		}
		// -c splits key from value at the first '='.
		if strings.ContainsAny(name, "=\n\x00") {
			return repoOverrides{}, errUnsafeRepoConfig
		}
		if k := section + "\x00" + name; !seen[k] {
			seen[k] = true
			*list = append(*list, name)
		}
	}
	return o, nil
}

// output runs git in c.root and returns its stdout, cut at c.limit.
func (g *gitRunner) output(ctx context.Context, c gitCall, args ...string) ([]byte, bool, error) {
	if c.heavy && g.backingOff(c.root) {
		return nil, false, errGitTimeout
	}
	o, err := g.repoOverrides(ctx, c)
	if err != nil {
		return nil, false, err
	}
	if !c.noFilters {
		o.filters = nil
	}
	return g.exec(ctx, c, o, args...)
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

func (g *gitRunner) exec(ctx context.Context, c gitCall, o repoOverrides, args ...string) ([]byte, bool, error) {
	hooksDir, err := noHooksDir()
	if err != nil {
		return nil, false, errNoHooksDir
	}
	timeout := g.timeout
	if c.write {
		ctx, timeout = context.WithoutCancel(ctx), g.writeTimeout
	}
	if c.heavy && c.tryOnly {
		// It takes a slot only when another stays free for a client, and
		// never waits for one.
		if len(g.sem) >= cap(g.sem)-1 {
			return nil, false, errGitBusy
		}
		// Nor while its root runs another: a root whose git waits on a
		// FIFO would otherwise hold both slots.
		release, ok := g.takeRootSlot(nil, c.root)
		if !ok {
			return nil, false, errGitBusy
		}
		defer release()
		select {
		case g.sem <- struct{}{}:
		default:
			return nil, false, errGitBusy
		}
		defer func() { <-g.sem }()
	} else if c.heavy {
		wait, cancelWait := context.WithTimeout(ctx, g.timeout)
		defer cancelWait()
		// A write (the user's own click) is not held behind the root's
		// reads, as git's index.lock already orders it.
		if !c.write {
			release, ok := g.takeRootSlot(wait, c.root)
			if !ok {
				return nil, false, errGitTimeout
			}
			defer release()
			// The command it waited for may have timed out meanwhile.
			if !c.noBackoff && g.backingOff(c.root) {
				return nil, false, errGitTimeout
			}
		}
		select {
		case g.sem <- struct{}{}:
		case <-wait.Done():
			return nil, false, errGitTimeout
		}
		defer func() { <-g.sem }()
	}

	run, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(run, g.bin, g.argv(c, o, hooksDir, args)...)
	if c.write {
		cmd.Cancel = interruptProcess(cmd)
	}
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
	err = cmd.Run()
	if stdout.truncated {
		// git was stopped because the rest is not wanted.
		return stdout.buf.Bytes(), true, nil
	}
	if errors.Is(run.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		if c.heavy && !c.noBackoff {
			g.mu.Lock()
			g.failedAt[c.root] = time.Now()
			g.mu.Unlock()
		}
		log.Printf("git %s in %s: timed out after %s", strings.Join(args, " "), c.root, timeout)
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
	// placeDirs are the Places, resolved: trusted in the container.
	placeDirs []string
	// windows: resolve refuses a directory off a drive letter (refusesDir);
	// runtime.GOOS == "windows", which tests replace.
	windows bool

	mu    sync.Mutex
	panes map[string]*paneRootState // stableKey → settle state
	now   func() time.Time
}

type paneRootState struct {
	root settling[filesRoot]
	dir  settling[string] // the pane's directory, apart: it moves within a root
	used time.Time
}

// settling is a value that changes only once a new one has been seen for
// rootSettle.
type settling[T comparable] struct {
	cur, next T
	nextSince time.Time // when next was first seen
}

func (s *settling[T]) see(v T, now time.Time) T {
	var zero T
	switch {
	case v == s.cur:
		s.next = zero
	case v != s.next:
		s.next, s.nextSince = v, now
	case now.Sub(s.nextSince) >= rootSettle:
		s.cur, s.next = v, zero
	}
	return s.cur
}

func newRootResolver(git *gitRunner) *rootResolver {
	return &rootResolver{
		git:           git,
		resolved:      newTTLCache[filesRoot](filesRootTTL),
		inContainer:   runningInContainer,
		ownedByServer: ownedByServer,
		windows:       runtime.GOOS == "windows",
		panes:         map[string]*paneRootState{},
		now:           time.Now,
	}
}

// paneRoot resolves the root of a pane and keeps it stable while the pane's
// directory only passes through another one.
func (rr *rootResolver) paneRoot(ctx context.Context, d PaneDirer, paneID string) (filesRoot, error) {
	return rr.paneRootAt(ctx, d, paneID, false)
}

// paneRootNow resolves the root of a pane from where it is now, without
// waiting for rootSettle: the user asked for it (Refresh in Files), so a
// directory the pane only passes through is what they want to see.
func (rr *rootResolver) paneRootNow(ctx context.Context, d PaneDirer, paneID string) (filesRoot, error) {
	return rr.paneRootAt(ctx, d, paneID, true)
}

func (rr *rootResolver) paneRootAt(ctx context.Context, d PaneDirer, paneID string, take bool) (filesRoot, error) {
	dir, key, err := d.PaneDir(ctx, paneID)
	if err != nil {
		return filesRoot{}, err
	}
	// On Windows every backend is checked (resolve does it again): Herdr
	// reports a pane's directory as its own process, which may have taken it
	// from what the pane printed.
	if rr.refusesDir(dir, mayBeFromPaneOutput(d)) {
		return filesRoot{}, errDirNotAvailable
	}
	root, err := rr.resolve(ctx, dir)
	if err != nil {
		return filesRoot{}, err
	}
	real := ""
	if abs, err := filepath.Abs(dir); err == nil {
		real, _ = evalSymlinks(abs)
	}
	return rr.settle(key, root, real, take), nil
}

// settle returns the pane's settled root, with its settled directory as Dir.
// The two settle apart, so a move within the new root does not hold the
// root back. take takes both as they are, settled from then on.
func (rr *rootResolver) settle(key string, root filesRoot, dir string, take bool) filesRoot {
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
		s = &paneRootState{root: settling[filesRoot]{cur: root}, dir: settling[string]{cur: dir}}
		rr.panes[key] = s
	}
	s.used = now
	if take {
		s.root = settling[filesRoot]{cur: root}
		s.dir = settling[string]{cur: dir}
	}
	out := s.root.see(root, now)
	out.Dir = s.dir.see(dir, now)
	return out
}

// refusesDir reports whether dir, which a pane may have announced, is
// refused before anything stats it: with checked, a directory off a drive
// letter (\\host\share, \\?\UNC\, \\.\) outside the Places. Opening one would
// make Windows connect to that host and send it the user's NTLM hash; a
// Place is the user's own choice. A drive path in the \\?\ form (Rust's
// canonicalize writes it) is one too.
func (rr *rootResolver) refusesDir(dir string, checked bool) bool {
	return checked && !validCwdForm(strings.TrimPrefix(dir, `\\?\`), true) && !rr.inPlace(dir)
}

// resolve returns the git toplevel of dir, or dir itself outside a repo. On
// Windows a directory refusesDir refuses is not available: the callers but
// placeRoot (Files, the worktree routes, the snapshot's nesting by git,
// herdr-core's repository tops) pass a pane's directory, which psmux may
// have taken from what the pane printed; a Place passes as one.
func (rr *rootResolver) resolve(ctx context.Context, dir string) (filesRoot, error) {
	if rr.refusesDir(dir, rr.windows) {
		return filesRoot{}, errDirNotAvailable
	}
	// Shared by every client asking for dir: a client that leaves must not
	// turn the repo into a plain directory for the others.
	ctx = context.WithoutCancel(ctx)
	return rr.resolved.do(dir, func() (filesRoot, error) {
		abs, err := filepath.Abs(dir)
		if err == nil {
			abs, err = evalSymlinks(abs)
		}
		if err != nil {
			return filesRoot{}, errDirNotAvailable
		}
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			return filesRoot{}, errDirNotAvailable
		}
		if rr.windows {
			if err := rr.repoConfigRefused(abs); err != nil {
				log.Printf("files: the repository of %s is not handed to git: %v", abs, err)
				return filesRoot{}, errDirNotAvailable
			}
		}
		top, gitDir, err := rr.toplevel(ctx, abs, "")
		var ge *gitError
		if errors.As(err, &ge) {
			if owned, ok := dubiousRepo(ge.stderr); ok {
				if !rr.trustRepo(owned) || !rr.trustGitEntry(owned) {
					log.Printf("files: %s not trusted by git (owner differs), browsing it as a plain directory", owned)
					return filesRoot{Root: abs}, nil
				}
				top, gitDir, err = rr.toplevel(ctx, abs, owned)
				if err == nil && (!rr.trustRepo(gitDir) || !rr.trustGitEntry(top)) {
					log.Printf("files: the git dir of %s is not trusted (owner differs), browsing it as a plain directory", owned)
					return filesRoot{Root: abs}, nil
				}
				if err == nil {
					return rr.repoRoot(ctx, abs, top, gitDir, owned), nil
				}
			}
		}
		switch {
		case err == nil:
			return rr.repoRoot(ctx, abs, top, gitDir, ""), nil
		case errors.As(err, &ge), errors.Is(err, exec.ErrNotFound), errors.Is(err, errNoHooksDir):
			// Not a repo, no git, or no hooks dir to run git with: the
			// directory itself.
			return filesRoot{Root: abs}, nil
		default:
			return filesRoot{}, err
		}
	})
}

// repoRoot is rootFromToplevel, except that a repository naming a file git
// would block on opening is browsed as the plain directory abs, its git dir
// still denied as a repository's is.
func (rr *rootResolver) repoRoot(ctx context.Context, abs, top, gitDir, safeDir string) filesRoot {
	root := rootFromToplevel(abs, top, gitDir, safeDir)
	if p := rr.blockingGitFile(ctx, root); p != "" {
		log.Printf("files: %s names %q, a FIFO or socket: browsing it as a plain directory", root.Root, p)
		return filesRoot{Root: abs, GitDir: root.GitDir}
	}
	return root
}

// blockingGitFile returns a file git reads in root's status or diff that is
// a FIFO (git waits on opening it until the timeout) or a socket, or "": the
// work tree's .gitignore and .gitattributes (not followed: git opens them
// without following a link), the shared git dir's info/exclude and
// info/attributes, and what core.excludesFile and core.attributesFile name
// (followed, as git follows them). Anything else, /dev/null and a missing
// file included, is passed: git reads it without waiting, or skips it. A
// .gitignore deeper in the tree is not looked for (that is a walk of the
// tree): such a root holds one of git's slots at most (gitRunner.exec). Not
// on Windows, which has no FIFO and empties both settings.
func (rr *rootResolver) blockingGitFile(ctx context.Context, root filesRoot) string {
	if rr.windows || !root.IsRepo {
		return ""
	}
	blocks := func(fi os.FileInfo, err error) bool {
		return err == nil && fi.Mode()&(os.ModeNamedPipe|os.ModeSocket) != 0
	}
	for _, name := range []string{".gitignore", ".gitattributes"} {
		if p := filepath.Join(root.Root, name); blocks(os.Lstat(p)) {
			return p
		}
	}
	var paths []string
	if common := commonGitDir(root.GitDir); common != "" {
		paths = append(paths, filepath.Join(common, "info", "exclude"), filepath.Join(common, "info", "attributes"))
	}
	// Exit 1 is no match. Any other failure leaves the settings unchecked;
	// the status that would read them meets the same failure.
	out, _, _ := rr.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, limit: 64 << 10},
		"config", "-z", "--type=path", "--get-regexp", `^core\.(excludesfile|attributesfile)$`)
	for _, kv := range strings.Split(string(out), "\x00") {
		_, v, _ := strings.Cut(kv, "\n")
		if v == "" {
			continue
		}
		if !filepath.IsAbs(v) {
			v = filepath.Join(root.Root, v)
		}
		paths = append(paths, v)
	}
	for _, p := range paths {
		if blocks(os.Stat(p)) {
			return p
		}
	}
	return ""
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
		if r, err := evalSymlinks(p); err == nil {
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
	target, ok := gitEntryTarget(top)
	return ok && underDir(target, gitDir) && underDir(gitDir, target)
}

// gitEntryTarget is the git directory top's .git leads to, resolved: that
// directory, or the one a gitfile names. ok false when top has no .git or a
// file there names none.
func gitEntryTarget(top string) (string, bool) {
	entry := filepath.Join(top, ".git")
	fi, err := os.Lstat(entry)
	if err != nil {
		return "", false
	}
	target := entry
	if fi.Mode().IsRegular() {
		f, err := os.Open(entry)
		if err != nil {
			return "", false
		}
		b, _ := io.ReadAll(io.LimitReader(f, 4096))
		f.Close()
		p, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
		if !ok {
			return "", false
		}
		target = filepath.FromSlash(strings.TrimSpace(p))
		if !filepath.IsAbs(target) {
			target = filepath.Join(top, target)
		}
	}
	if r, err := evalSymlinks(target); err == nil {
		target = r
	}
	return filepath.Clean(target), true
}

// trustRepo decides whether to pass safe.directory for a repo git refused
// for its owner: only when the server's own user owns it, or inside the
// container for the mounted workspace or a Place (the host user's uid
// differs).
func (rr *rootResolver) trustRepo(path string) bool {
	if rr.ownedByServer(path) {
		return true
	}
	if !rr.inContainer() {
		return false
	}
	rel, err := filepath.Rel(containerWorkspace, path)
	if err == nil && filepath.IsLocal(rel) {
		return true
	}
	// A Place is mounted from the host like the workspace.
	return rr.inPlace(path)
}

// trustGitEntry decides whether the .git entry of the work tree dir (a
// dir, or a file naming the git dir) is trusted as trustRepo trusts dir, when
// there is one. safe.directory names only the work tree: another user who
// could write a .git into the server user's directory, or point its git dir
// elsewhere, would otherwise have git read their config, index and objects.
// It is checked before git runs with safe.directory, and the git dir git then
// names right after.
func (rr *rootResolver) trustGitEntry(dir string) bool {
	entry := filepath.Join(dir, ".git")
	if _, err := os.Lstat(entry); err != nil {
		return errors.Is(err, os.ErrNotExist)
	}
	return rr.trustRepo(entry)
}

// inPlace reports whether path is inside one of the Places.
func (rr *rootResolver) inPlace(path string) bool {
	return slices.ContainsFunc(rr.placeDirs, func(d string) bool { return underDir(d, path) })
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
