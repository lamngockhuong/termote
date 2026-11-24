package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ciPoller follows the pull requests of every unfinished job in the
// background, with the user's gh (gh_runner.go), whether a client is open
// or not, so a failed check or a merge can be pushed. Where a job's pull
// requests are asked is worked out once from its worktree, or from its
// agent's folder for a job without one, and kept on the job: a job whose
// agent left is still followed. Each read is one write of the ledger,
// which decides there (under jobs.lock) whether something is new: a push
// only follows a write that succeeded, and a set of failures already
// pushed is never pushed again, a restart included.

const (
	ciTick         = 10 * time.Second
	ciEvery        = 60 * time.Second
	ciPendingEvery = 20 * time.Second
	ciSlowEvery    = 5 * time.Minute
	ciMostBackoff  = 15 * time.Minute
	// ciQuietAfter: a job without a pull request this long after it was
	// made is read every ciSlowEvery.
	ciQuietAfter = 30 * time.Minute
	// ciRefreshGap: a refresh of one job within this long of its last read
	// gets that read.
	ciRefreshGap = 10 * time.Second
	// ciRefreshPerMinute refreshes a server takes in a minute.
	ciRefreshPerMinute = 30
	ciDefaultTTL       = time.Hour
	// ciRefreshMost bounds a refresh's read.
	ciRefreshMost = 90 * time.Second
	// ciTargetTTL: where a folder's pull requests are asked is read again
	// after this long (git runs a few times for it).
	ciTargetTTL = 2 * time.Minute
	ciNoneKey   = "none"
)

type ciPoller struct {
	a   *agentAPI
	gh  *ghRunner
	git *gitRunner
	// resolve is the files routes' root resolver (rootResolver.resolve).
	resolve func(ctx context.Context, dir string) (filesRoot, error)
	// sshHost is the host ssh connects to for an SSH remote's host (an
	// alias of ~/.ssh/config), "" when it cannot tell; nil asks nothing.
	sshHost func(ctx context.Context, host string) string
	now     func() time.Time

	// onFailed, onMerged are told the id of a job whose checks failed anew
	// or whose pull requests all merged or closed, after the write.
	onFailed func(id string)
	onMerged func(id string)
	// afterRead runs after a read was written (the CI grant, job_ci_send.go).
	afterRead func(ctx context.Context, j job)

	mu        sync.Mutex
	state     map[string]*ciJobState
	defaults  map[string]ciDefault
	targets   map[string]ciTargetAt
	refreshes []time.Time
	off       bool
}

type ciJobState struct {
	next    time.Time
	fails   int
	checked time.Time
	// running is closed when the job's read in flight ends.
	running chan struct{}
	// sendKey, sendTries, sendNext: the set of failures an automatic send
	// tries, how often the agent refused it, and when to try again.
	sendKey   string
	sendTries int
	sendNext  time.Time
	// sending: an automatic send of the job runs
	sending bool
}

type ciDefault struct {
	name string
	at   time.Time
}

func newCIPoller(a *agentAPI, files *filesAPI, dir string) *ciPoller {
	p := &ciPoller{a: a, gh: newGhRunner(dir), git: files.git, resolve: files.roots.resolve, sshHost: sshHostName,
		now: time.Now, state: map[string]*ciJobState{}, defaults: map[string]ciDefault{}, targets: map[string]ciTargetAt{}}
	p.afterRead = p.autoSend
	return p
}

// available: the server follows pull requests.
func (p *ciPoller) available() bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.off
}

// checkedAt is when a job's pull requests were last read (or tried), kept
// in memory only.
func (p *ciPoller) checkedAt(id string) time.Time {
	if p == nil {
		return time.Time{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if s := p.state[id]; s != nil {
		return s.checked
	}
	return time.Time{}
}

// run reads the due jobs every ciTick until ctx ends.
func (p *ciPoller) run(ctx context.Context) {
	t := time.NewTicker(ciTick)
	defer t.Stop()
	for {
		p.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// tick starts a read of every unfinished job that is due and not being
// read; gh's own semaphore bounds how many run at once.
func (p *ciPoller) tick(ctx context.Context) {
	if !p.available() {
		return
	}
	list, readOnly := p.a.jobs.jobs()
	if readOnly {
		p.stop("the job ledger was saved by a newer Termote")
		return
	}
	now := p.now()
	live := map[string]bool{}
	var due []string
	p.mu.Lock()
	for _, j := range list {
		if jobFinished(j.State) {
			continue
		}
		live[j.ID] = true
		s := p.state[j.ID]
		if s == nil {
			s = &ciJobState{}
			p.state[j.ID] = s
		}
		if s.running == nil && !now.Before(s.next) {
			s.running = make(chan struct{})
			due = append(due, j.ID)
		}
	}
	for id, s := range p.state {
		if !live[id] && s.running == nil {
			delete(p.state, id)
		}
	}
	p.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range due {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.readClaimed(ctx, id)
		}()
	}
	wg.Wait()
}

func (p *ciPoller) stop(why string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.off {
		log.Printf("ci: pull requests are not followed any more: %s", why)
		p.off = true
	}
}

// readClaimed reads job id, whose running channel the caller made, then
// sets when it is due next.
func (p *ciPoller) readClaimed(ctx context.Context, id string) {
	saved, err := p.read(ctx, id)
	p.mu.Lock()
	s := p.state[id]
	if s == nil {
		s = &ciJobState{}
		p.state[id] = s
	}
	now := p.now()
	s.checked = now
	switch {
	case errors.Is(err, errCIBusy):
		s.next = now.Add(ciEvery)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// Cut short: no failure of the job's, read at the next tick.
	case err != nil:
		s.fails++
		s.next = now.Add(min(ciEvery<<min(s.fails, 6), ciMostBackoff))
	default:
		s.fails = 0
		s.next = now.Add(ciNextRead(saved, now))
	}
	if s.running != nil {
		close(s.running)
		s.running = nil
	}
	p.mu.Unlock()
}

// ciNextRead is how long until j's pull requests are read again.
func ciNextRead(j job, now time.Time) time.Duration {
	sum := ciSummary(j.CI)
	switch {
	case sum == nil && now.Sub(j.Created) > ciQuietAfter, sum != nil && sum.AllMerged:
		return ciSlowEvery
	case j.CI != nil && slices.ContainsFunc(j.CI.PRs, func(pr jobPR) bool { return pr.State == prOpen && pr.Checks == ciPending }):
		return ciPendingEvery
	}
	return ciEvery
}

// refresh reads job id now (or waits for the read in flight) and returns
// it as that read left it, a ci_* error included.
func (p *ciPoller) refresh(ctx context.Context, id string) (job, error) {
	if !p.available() {
		return job{}, errCIUnavailable
	}
	p.mu.Lock()
	s := p.state[id]
	if s == nil {
		s = &ciJobState{}
		p.state[id] = s
	}
	now := p.now()
	if w := s.running; w != nil {
		p.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
			return job{}, ctx.Err()
		}
		j, _ := p.a.jobs.job(id)
		return j, nil
	}
	if !s.checked.IsZero() && now.Sub(s.checked) < ciRefreshGap {
		p.mu.Unlock()
		j, _ := p.a.jobs.job(id)
		return j, nil
	}
	cut := now.Add(-time.Minute)
	p.refreshes = slices.DeleteFunc(p.refreshes, func(t time.Time) bool { return t.Before(cut) })
	if len(p.refreshes) >= ciRefreshPerMinute {
		p.mu.Unlock()
		return job{}, errCIBusy
	}
	p.refreshes = append(p.refreshes, now)
	s.running = make(chan struct{})
	p.mu.Unlock()
	// The read ends even when the client leaves: a cut one would read as a
	// failure of the job's.
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ciRefreshMost)
	defer cancel()
	p.readClaimed(rctx, id)
	j, ok := p.a.jobs.job(id)
	if !ok {
		return job{}, errJobNotFound
	}
	return j, nil
}

// ciTarget is where a job's pull requests are asked.
type ciTarget struct {
	repo, push ghRepo
	branch     string
	// byBranch: pull requests are looked for by the branch (not the
	// repository's default branch).
	byBranch bool
}

// read reads job id's pull requests and writes what changed.
func (p *ciPoller) read(ctx context.Context, id string) (job, error) {
	j, ok := p.a.jobs.job(id)
	if !ok || jobFinished(j.State) {
		return j, nil
	}
	t, err := p.target(ctx, j)
	if err != nil && errors.Is(err, errCIWait) {
		return j, nil
	}
	var prs []jobPR
	if err == nil {
		prs, err = p.pullRequests(ctx, j, t)
	}
	var pushFail, pushMerged bool
	saved, wrote, werr := p.a.jobs.setJobCI(id, func(j *job) bool {
		before := j.CI.clone()
		c := j.CI.clone()
		if c == nil {
			c = &jobCI{}
		}
		if err != nil {
			code := ciErrorCode(err)
			if code == "" || code == c.Error {
				return false
			}
			c.Error = code
			j.CI = c
			return true
		}
		// What the job is followed by changed while gh ran: this read is
		// another branch's.
		if j.Worktree == nil && c.Branch != "" && c.Branch != t.branch {
			return false
		}
		// Kept only once it is a branch of the job's own: a pane still on
		// the default branch is read again from its folder next time.
		if j.Worktree == nil && t.byBranch {
			c.Branch = t.branch
		}
		c.Repo, c.Push, c.Error = t.repo.String(), t.push.String(), ""
		// A pull request detached while gh ran stays detached.
		c.PRs = slices.DeleteFunc(slices.Clone(prs), func(pr jobPR) bool { return pr.Pinned && !slices.Contains(c.Pins, pr.Number) })
		pushFail, pushMerged = ciTransition(c, p.a.jobs, j)
		if reflect.DeepEqual(before, c) {
			return false
		}
		j.CI = c
		return true
	})
	if werr != nil {
		if errors.Is(werr, errJobsNewer) {
			p.stop("the job ledger was saved by a newer Termote")
		}
		log.Printf("ci: write job %s: %v", id, werr)
		return j, werr
	}
	if !wrote {
		saved, _ = p.a.jobs.job(id)
	}
	if pushFail && p.onFailed != nil {
		p.onFailed(id)
	}
	if pushMerged && p.onMerged != nil {
		p.onMerged(id)
	}
	if err == nil && p.afterRead != nil {
		p.sendAfter(ctx, saved)
	}
	return saved, err
}

// sendAfter runs afterRead (the automatic send, which can wait for the
// pane's lock and a paste) apart from the reads, one per job at a time, so
// a slow pane holds up neither the other jobs' reads nor a refresh.
func (p *ciPoller) sendAfter(ctx context.Context, j job) {
	p.mu.Lock()
	s := p.state[j.ID]
	if s == nil {
		s = &ciJobState{}
		p.state[j.ID] = s
	}
	if s.sending {
		p.mu.Unlock()
		return
	}
	s.sending = true
	p.mu.Unlock()
	go func() {
		defer func() {
			p.mu.Lock()
			s.sending = false
			p.mu.Unlock()
		}()
		p.afterRead(context.WithoutCancel(ctx), j)
	}()
}

// ciTransition moves c.Notified to what c's pull requests show now and
// adds the job's history line; it says what to push. The first read of a
// job only sets the mark, so an upgrade pushes nothing old.
func ciTransition(c *jobCI, s *jobStore, j *job) (fail, merged bool) {
	sum := ciSummary(c)
	key := ciFailKey(c.PRs, true)
	first := c.Notified == ""
	switch {
	case sum != nil && sum.AllMerged:
		if c.Notified != ciMergedKey && !first {
			merged = true
			s.addEvent(j, "ci", "all pull requests merged or closed")
		}
		c.Notified = ciMergedKey
	case key != "":
		if !first && ciKeyGains(key, c.Notified) {
			fail = true
			s.addEvent(j, "ci", ciFailText(c.PRs))
		}
		c.Notified = key
	default:
		c.Notified = ciNoneKey
	}
	return fail, merged
}

// ciFailText is "CI failed on #12: lint, e2e; #15: build".
func ciFailText(prs []jobPR) string {
	var parts []string
	for _, pr := range prs {
		if pr.State == prOpen && pr.Checks == ciFail {
			parts = append(parts, "#"+strconv.Itoa(pr.Number)+": "+strings.Join(pr.Failing, ", "))
		}
	}
	return "CI failed on " + strings.Join(parts, "; ")
}

// pullRequests reads the job's pull requests: those of its branch (opened
// from the pushed repo, and a closed one only when made after the job),
// then each one attached by number.
func (p *ciPoller) pullRequests(ctx context.Context, j job, t ciTarget) ([]jobPR, error) {
	var out []jobPR
	if t.byBranch {
		list, err := p.gh.listPRs(ctx, t.repo, t.branch)
		if err != nil {
			return nil, err
		}
		for _, g := range list {
			pr, ok := toJobPR(g, t.repo, t.push)
			if !ok || pr.Foreign || (pr.State != prOpen && g.CreatedAt.Before(j.Created)) {
				continue
			}
			out = append(out, pr)
		}
	}
	var pins []int
	if j.CI != nil {
		pins = j.CI.Pins
	}
	for _, n := range pins {
		if i := slices.IndexFunc(out, func(pr jobPR) bool { return pr.Number == n }); i >= 0 {
			out[i].Pinned = true
			continue
		}
		g, err := p.gh.viewPR(ctx, t.repo, n)
		if errors.Is(err, errPRNotFound) {
			// No such pull request in the repo: nothing to show for it
			// (the PWA lists the number to detach it).
			continue
		}
		if err != nil {
			return nil, err
		}
		if pr, ok := toJobPR(g, t.repo, t.push); ok {
			pr.Pinned = true
			out = append(out, pr)
		}
	}
	slices.SortStableFunc(out, func(a, b jobPR) int { return b.Number - a.Number })
	if len(out) > maxJobPRs {
		out = out[:maxJobPRs]
	}
	return out, nil
}

var (
	errCIWait        = errors.New("nothing to read yet")
	errCIUnavailable = &codedError{"ci_unavailable", "pull requests are not followed on this server", http.StatusServiceUnavailable}
	remoteNameRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`)
)

// target works out where j's pull requests are asked: from its worktree
// while the folder is there, else from what was kept; for a job without a
// worktree, from its agent's folder the first time, then from what was
// kept. errCIWait: nothing known yet (the agent's folder is not read yet).
func (p *ciPoller) target(ctx context.Context, j job) (ciTarget, error) {
	var dir, branch string
	switch {
	case j.Worktree != nil:
		branch = j.Worktree.Branch
		if fi, err := os.Stat(j.Worktree.Dir); err == nil && fi.IsDir() {
			dir = j.Worktree.Dir
		}
	case j.CI != nil && j.CI.Branch != "" && j.CI.Repo != "":
		branch = j.CI.Branch
	case j.Agent != nil:
		snap, err := peekSnapshot(ctx, p.a.m)
		if err != nil {
			return ciTarget{}, errCIWait
		}
		live := p.a.jobLiveIn(snap, j)
		if live.Dir == "" || live.Status == "gone" || live.Status == "unknown" {
			return ciTarget{}, errCIWait
		}
		dir = live.Dir
	default:
		if j.CI != nil && len(j.CI.Pins) > 0 {
			return ciTarget{}, errNoRepo
		}
		return ciTarget{}, errCIWait
	}
	t := ciTarget{branch: branch}
	if dir != "" {
		if jobDirTooWide(dir, p.a.home) {
			return ciTarget{}, errNoRepo
		}
		var err error
		t, err = p.targetIn(ctx, dir, branch)
		if err != nil {
			return ciTarget{}, err
		}
	} else {
		r, ok1 := parseRepoString(ciField(j, func(c *jobCI) string { return c.Repo }))
		pu, ok2 := parseRepoString(ciField(j, func(c *jobCI) string { return c.Push }))
		if !ok1 || !ok2 || !validBranchName(branch) {
			return ciTarget{}, errNoRepo
		}
		t.repo, t.push = r, pu
	}
	if err := p.checkHost(ctx, &t); err != nil {
		return ciTarget{}, err
	}
	def, err := p.defaultBranch(ctx, t.repo)
	if err != nil {
		return ciTarget{}, err
	}
	t.byBranch = t.branch != "" && !(t.repo == t.push && t.branch == def)
	return t, nil
}

func ciField(j job, f func(*jobCI) string) string {
	if j.CI == nil {
		return ""
	}
	return f(j.CI)
}

// parseRepoString reads a kept host/owner/repo.
func parseRepoString(s string) (ghRepo, bool) {
	host, rest, ok := strings.Cut(s, "/")
	if !ok {
		return ghRepo{}, false
	}
	return parseRemoteURL("https://" + host + "/" + rest)
}

// targetIn reads, with git in dir's repository, the branch (when not
// given), the repo it is pushed to, and where its pull requests are: the
// upstream remote when there is one besides (a fork), else the same.
func (p *ciPoller) targetIn(ctx context.Context, dir, branch string) (ciTarget, error) {
	key := dir + "\x00" + branch
	p.mu.Lock()
	c, ok := p.targets[key]
	p.mu.Unlock()
	if ok && p.now().Sub(c.at) < ciTargetTTL {
		return c.t, nil
	}
	t, err := p.readTarget(ctx, dir, branch)
	if err == nil {
		p.mu.Lock()
		p.targets[key] = ciTargetAt{t: t, at: p.now()}
		p.mu.Unlock()
	}
	return t, err
}

type ciTargetAt struct {
	t  ciTarget
	at time.Time
}

// readTarget is targetIn without the cache. A read cut short is ctx's
// error, never ci_no_repo.
func (p *ciPoller) readTarget(ctx context.Context, dir, branch string) (t ciTarget, err error) {
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = ctx.Err()
		}
	}()
	root, err := p.resolve(ctx, dir)
	if err != nil || !root.IsRepo {
		return ciTarget{}, errNoRepo
	}
	git := func(args ...string) string {
		out, _, err := p.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, limit: 64 << 10}, args...)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	if branch == "" {
		branch = git("symbolic-ref", "--short", "-q", "HEAD")
	}
	if !validBranchName(branch) {
		return ciTarget{}, errNoRepo
	}
	remotes := strings.Fields(git("remote"))
	pushName := pushRemoteName(git, remotes, branch)
	if pushName == "" {
		return ciTarget{}, errNoRepo
	}
	push, ok := p.remoteRepo(ctx, git("remote", "get-url", pushName))
	if !ok {
		return ciTarget{}, errNoRepo
	}
	repo := push
	if up := pickRemote(remotes, "upstream"); up != "" && up != pushName {
		if r, ok := p.remoteRepo(ctx, git("remote", "get-url", up)); ok && r.Host == push.Host {
			repo = r
		}
	}
	return ciTarget{repo: repo, push: push, branch: branch}, nil
}

// remoteRepo reads a remote's URL as parseRemoteURL does; the host of an
// SSH URL is then the one ssh connects to, as gh reads it: an alias of
// ~/.ssh/config (Host work.github.com, HostName github.com) is the host it
// names. An https URL is taken as it is.
func (p *ciPoller) remoteRepo(ctx context.Context, raw string) (ghRepo, bool) {
	r, ok := parseRemoteURL(raw)
	if !ok || p.sshHost == nil || !isSSHRemote(raw) {
		return r, ok
	}
	if h := p.sshHost(ctx, r.Host); h != "" {
		r.Host = h
	}
	return r, true
}

// pushRemoteName is the remote branch is pushed to, as git push picks it
// (branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote, origin),
// among remotes; "" when none of them is one. git runs a git command in the
// branch's repository and answers its trimmed output, "" on failure.
func pushRemoteName(git func(args ...string) string, remotes []string, branch string) string {
	return pickRemote(remotes, git("config", "--get", "branch."+branch+".pushRemote"), git("config", "--get", "remote.pushDefault"),
		git("config", "--get", "branch."+branch+".remote"), "origin")
}

// pickRemote is the first of names that is a remote of remotes.
func pickRemote(remotes []string, names ...string) string {
	for _, n := range names {
		if n != "" && remoteNameRe.MatchString(n) && slices.Contains(remotes, n) {
			return n
		}
	}
	return ""
}

// checkHost maps an SSH alias (a host without a dot, a Host entry of
// ~/.ssh/config) to github.com only when github.com is the one host gh is
// signed in to: with another one the alias may name a GitHub Enterprise,
// and a repository of the same name on github.com would be read instead,
// so it is ci_no_repo, as when gh cannot list its hosts. Then only a host
// gh is signed in to is accepted: github.com not signed in is ci_gh_auth,
// any other host ci_no_repo (gh would send it nothing, and gh auth login
// is not the user's fix for a remote elsewhere).
func (p *ciPoller) checkHost(ctx context.Context, t *ciTarget) error {
	for _, r := range []*ghRepo{&t.repo, &t.push} {
		if strings.Contains(r.Host, ".") {
			continue
		}
		hosts, err := p.gh.signedInHosts(ctx)
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case errors.Is(err, errCIBusy), errors.Is(err, errGhMissing):
			return err
		case err != nil || !slices.Equal(hosts, []string{"github.com"}):
			return errNoRepo
		}
		r.Host = "github.com"
	}
	ok, err := p.gh.signedIn(ctx, t.repo.Host)
	switch {
	case err != nil:
		return err
	case !ok && t.repo.Host == "github.com":
		return errGhAuth
	case !ok:
		return errNoRepo
	}
	return nil
}

// defaultBranch is repo's default branch, kept an hour.
func (p *ciPoller) defaultBranch(ctx context.Context, repo ghRepo) (string, error) {
	key := repo.String()
	p.mu.Lock()
	d, ok := p.defaults[key]
	p.mu.Unlock()
	if ok && p.now().Sub(d.at) < ciDefaultTTL {
		return d.name, nil
	}
	name, err := p.gh.defaultBranch(ctx, repo)
	if err != nil {
		if errors.Is(err, errGhAuth) {
			p.gh.forgetAuth(repo.Host)
		}
		return "", err
	}
	p.mu.Lock()
	p.defaults[key] = ciDefault{name: name, at: p.now()}
	p.mu.Unlock()
	return name, nil
}
