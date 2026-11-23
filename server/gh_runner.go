package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ghRunner is the only place the server runs the GitHub CLI, to read a
// job's pull requests and their checks under the gh login of the user the
// server runs as. Termote keeps no token. gh never runs in a repository:
// the server works out host/owner/repo itself (job_ci.go, through
// gitRunner) and passes it as one --repo= argument, with the state dir as
// the working directory and an environment that names no other repo, host
// or enterprise token. Its errors are classified into ci_* codes; gh's own
// text is logged, cut, and never reaches a client or the ledger.

const (
	ghTimeout = 20 * time.Second
	// ghOutputMax bounds what gh prints.
	ghOutputMax = 1 << 20
	// ghParallel calls run at once.
	ghParallel = 2
	// ghHourBudget calls a server makes in an hour at most.
	ghHourBudget = 1200
	// ghRateLimitPause: after GitHub said the rate limit is reached, no
	// call for this long.
	ghRateLimitPause = 15 * time.Minute
	// ghLookAgain: a missing gh is looked for again after this long.
	ghLookAgain = 10 * time.Minute
	// ghAuthTTL: how long a host's login state is trusted.
	ghAuthTTL = 10 * time.Minute
	// ghSameCall: an identical call within this long gets the last answer
	// (two jobs on one branch, a refresh right after a poll).
	ghSameCall = 5 * time.Second
)

var (
	errGhMissing = &codedError{"ci_gh_missing", "gh is not installed on the server", http.StatusServiceUnavailable}
	errGhAuth    = &codedError{"ci_gh_auth", "gh is not signed in on the server: run gh auth login there", http.StatusServiceUnavailable}
	errGhFailed  = &codedError{"ci_failed", "gh could not read the pull requests", http.StatusBadGateway}
	errNoRepo    = &codedError{"ci_no_repo", "the job's branch is not on a GitHub repository gh is signed in to", http.StatusConflict}
	errCIBusy    = &codedError{"ci_busy", "too many GitHub reads: try again later", http.StatusTooManyRequests}
)

// ciErrorCode is the code a failed read leaves on the job; "" for a call
// skipped by the budget, which is no failure of the job's.
func ciErrorCode(err error) string {
	var ce *codedError
	switch {
	case err == nil, errors.Is(err, errCIBusy):
		return ""
	case errors.As(err, &ce) && strings.HasPrefix(ce.code, "ci_"):
		return ce.code
	}
	return errGhFailed.code
}

// ghEnvDrop: variables that would point gh at another host or repo, or hand
// a token to a host that is not github.com.
var ghEnvDrop = []string{"GH_HOST", "GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}

// ghEnv is the server environment for gh: no git or Termote variable, none
// of ghEnvDrop, and no prompt, pager, colour or update check.
func ghEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if isTermoteEnv(kv) || len(k) >= 4 && strings.EqualFold(k[:4], "GIT_") || containsFold(ghEnvDrop, k) {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GH_PAGER=cat",
		"GH_SPINNER_DISABLED=1", "CLICOLOR=0")
}

type ghRunner struct {
	// dir is where gh runs: the server's state dir, never a repository.
	dir string
	// prefix goes before gh's arguments (tests run a helper process).
	prefix []string
	// look finds gh; replaced by tests.
	look func() string
	now  func() time.Time
	sem  chan struct{}
	same *ttlCache[[]byte]

	mu       sync.Mutex
	bin      string
	lookedAt time.Time
	calls    []time.Time
	paused   time.Time
	auth     map[string]ghAuth
}

type ghAuth struct {
	ok bool
	at time.Time
}

func newGhRunner(dir string) *ghRunner {
	return &ghRunner{dir: dir, look: lookGh, now: time.Now, sem: make(chan struct{}, ghParallel),
		same: newTTLCache[[]byte](ghSameCall), auth: map[string]ghAuth{}}
}

// lookGh finds gh on the service's PATH, then where package managers put it.
func lookGh() string {
	if p, err := exec.LookPath("gh"); err == nil && ghUsable(p) {
		return p
	}
	home, _ := os.UserHomeDir()
	var dirs []string
	name := "gh"
	if runtime.GOOS == "windows" {
		name = "gh.exe"
		for _, base := range []string{os.Getenv("ProgramFiles"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
			if base != "" && filepath.IsAbs(base) {
				dirs = append(dirs, filepath.Join(base, "GitHub CLI"))
			}
		}
	} else {
		dirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin"}
		if home != "" {
			dirs = append(dirs, filepath.Join(home, ".local", "bin"), filepath.Join(home, "bin"))
		}
	}
	for _, d := range dirs {
		if p := filepath.Join(d, name); ghUsable(p) {
			return p
		}
	}
	return ""
}

// ghUsable: p is a regular file, executable, and on Unix writable by no one
// but its owner's group at most.
func ghUsable(p string) bool {
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return fi.Mode().Perm()&0o111 != 0 && fi.Mode().Perm()&0o002 == 0
}

// path is gh's path, looked for again at most every ghLookAgain while
// missing.
func (g *ghRunner) path() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.bin == "" && (g.lookedAt.IsZero() || g.now().Sub(g.lookedAt) >= ghLookAgain) {
		g.bin, g.lookedAt = g.look(), g.now()
	}
	return g.bin
}

// spend takes one call of the budget, refusing while GitHub's rate limit
// pause lasts or the hour's calls are spent.
func (g *ghRunner) spend() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if now.Before(g.paused) {
		return false
	}
	cut := now.Add(-time.Hour)
	g.calls = slices.DeleteFunc(g.calls, func(t time.Time) bool { return t.Before(cut) })
	if len(g.calls) >= ghHourBudget {
		return false
	}
	g.calls = append(g.calls, now)
	return true
}

var ghRateLimitRe = regexp.MustCompile(`(?i)rate limit|abuse detection`)
var ghAuthRe = regexp.MustCompile(`(?i)gh auth login|not logged in|authentication|HTTP 401|bad credentials`)

// run runs gh with args and returns its stdout.
func (g *ghRunner) run(ctx context.Context, args ...string) ([]byte, error) {
	key := strings.Join(args, "\x00")
	return g.same.do(key, func() ([]byte, error) {
		bin := g.path()
		if bin == "" {
			return nil, errGhMissing
		}
		if !g.spend() {
			return nil, errCIBusy
		}
		select {
		case g.sem <- struct{}{}:
		case <-ctx.Done():
			return nil, errCIBusy
		}
		defer func() { <-g.sem }()
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ghTimeout)
		defer cancel()
		cmd := exec.CommandContext(cctx, bin, slices.Concat(g.prefix, args)...)
		cmd.Dir = g.dir
		cmd.Env = ghEnv()
		var out limitedBuffer
		out.max = ghOutputMax
		var stderr limitedBuffer
		stderr.max = 4 << 10
		cmd.Stdout, cmd.Stderr = &out, &stderr
		err := cmd.Run()
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			g.mu.Lock()
			g.bin = ""
			g.mu.Unlock()
			return nil, errGhMissing
		}
		if err != nil {
			msg := strings.TrimSpace(stderr.String())
			log.Printf("ci: gh %s: %v: %s", args[0], err, cutRunes(msg, 200))
			switch {
			case ghRateLimitRe.MatchString(msg):
				g.mu.Lock()
				g.paused = g.now().Add(ghRateLimitPause)
				g.mu.Unlock()
				return nil, errCIBusy
			case ghAuthRe.MatchString(msg):
				return nil, errGhAuth
			}
			return nil, errGhFailed
		}
		if out.over {
			return nil, errGhFailed
		}
		return out.Bytes(), nil
	})
}

// limitedBuffer keeps the first max bytes written and notes the rest.
type limitedBuffer struct {
	bytes.Buffer
	max  int
	over bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room < len(p) {
		b.over = true
		if room > 0 {
			b.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

var _ io.Writer = (*limitedBuffer)(nil)

// signedIn: gh has a login for host (checked once per ghAuthTTL).
func (g *ghRunner) signedIn(ctx context.Context, host string) (bool, error) {
	g.mu.Lock()
	a, ok := g.auth[host]
	g.mu.Unlock()
	if ok && g.now().Sub(a.at) < ghAuthTTL {
		return a.ok, nil
	}
	_, err := g.run(ctx, "auth", "status", "--hostname="+host)
	// gh exits 1 for a host it has no login for.
	if err != nil && !errors.Is(err, errGhAuth) && !errors.Is(err, errGhFailed) {
		return false, err
	}
	g.mu.Lock()
	g.auth[host] = ghAuth{ok: err == nil, at: g.now()}
	g.mu.Unlock()
	return err == nil, nil
}

// forgetAuth drops what is known of host's login (a call said it is gone).
func (g *ghRunner) forgetAuth(host string) {
	g.mu.Lock()
	delete(g.auth, host)
	g.mu.Unlock()
}

// ghRepo is host/owner/repo.
type ghRepo struct{ Host, Owner, Name string }

func (r ghRepo) String() string { return r.Host + "/" + r.Owner + "/" + r.Name }

var (
	ghNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	ghHostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$`)
	scpURLRe = regexp.MustCompile(`^(?:[A-Za-z0-9._-]+@)?([^:/]+):(.+)$`)
)

// parseRemoteURL reads host/owner/repo from a git remote URL: https,
// ssh://, or the scp form git@host:owner/repo(.git). ssh.github.com (SSH
// over 443) is github.com; a host without a dot is an SSH alias, returned
// as is for the caller to map.
func parseRemoteURL(raw string) (ghRepo, bool) {
	raw = strings.TrimSpace(raw)
	var host, path string
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
		if u.Scheme != "https" && u.Scheme != "ssh" && u.Scheme != "git+ssh" && u.Scheme != "http" {
			return ghRepo{}, false
		}
		host, path = u.Hostname(), u.Path
	} else if m := scpURLRe.FindStringSubmatch(raw); m != nil && !strings.Contains(raw, "://") {
		host, path = m[1], m[2]
	} else {
		return ghRepo{}, false
	}
	host = strings.ToLower(host)
	if host == "ssh.github.com" || host == "www.github.com" {
		host = "github.com"
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(strings.Trim(path, "/"), ".git"), "/"), "/")
	if len(parts) != 2 || !ghHostRe.MatchString(host) || !ghNameRe.MatchString(parts[0]) || !ghNameRe.MatchString(parts[1]) ||
		parts[1] == "." || parts[1] == ".." {
		return ghRepo{}, false
	}
	return ghRepo{Host: host, Owner: parts[0], Name: parts[1]}, true
}

// ghPR is a pull request as gh pr list/view --json prints it.
type ghPR struct {
	Number         int    `json:"number"`
	State          string `json:"state"`
	IsDraft        bool   `json:"isDraft"`
	URL            string `json:"url"`
	HeadRefOid     string `json:"headRefOid"`
	HeadRepository *struct {
		Name string `json:"name"`
	} `json:"headRepository"`
	HeadRepositoryOwner *struct {
		Login string `json:"login"`
	} `json:"headRepositoryOwner"`
	CreatedAt         time.Time `json:"createdAt"`
	StatusCheckRollup []struct {
		Typename   string `json:"__typename"`
		Name       string `json:"name"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
		DetailsURL string `json:"detailsUrl"`
		Context    string `json:"context"`
		State      string `json:"state"`
		TargetURL  string `json:"targetUrl"`
	} `json:"statusCheckRollup"`
}

const ghPRFields = "number,state,isDraft,url,headRefOid,headRepository,headRepositoryOwner,createdAt,statusCheckRollup"

var (
	ghFailConclusions = []string{"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}
	ghHeadRe          = regexp.MustCompile(`^[0-9a-f]{40}$`)
	ghRunRe           = regexp.MustCompile(`/actions/runs/([0-9]{1,19})(/|$)`)
)

// listPRs reads the pull requests of repo whose head branch is branch.
func (g *ghRunner) listPRs(ctx context.Context, repo ghRepo, branch string) ([]ghPR, error) {
	out, err := g.run(ctx, "pr", "list", "--repo="+repo.String(), "--head="+branch, "--state=all", "--limit=20", "--json="+ghPRFields)
	if err != nil {
		return nil, err
	}
	var prs []ghPR
	if err := json.Unmarshal(out, &prs); err != nil {
		log.Printf("ci: gh pr list of %s: %v", repo, err)
		return nil, errGhFailed
	}
	return prs, nil
}

// viewPR reads one pull request of repo.
func (g *ghRunner) viewPR(ctx context.Context, repo ghRepo, n int) (ghPR, error) {
	out, err := g.run(ctx, "pr", "view", strconv.Itoa(n), "--repo="+repo.String(), "--json="+ghPRFields)
	if err != nil {
		return ghPR{}, err
	}
	var pr ghPR
	if err := json.Unmarshal(out, &pr); err != nil || pr.Number != n {
		log.Printf("ci: gh pr view %d of %s: %v", n, repo, err)
		return ghPR{}, errGhFailed
	}
	return pr, nil
}

// defaultBranch is repo's default branch.
func (g *ghRunner) defaultBranch(ctx context.Context, repo ghRepo) (string, error) {
	out, err := g.run(ctx, "repo", "view", repo.String(), "--json=defaultBranchRef")
	if err != nil {
		return "", err
	}
	var v struct {
		DefaultBranchRef struct {
			Name string `json:"name"`
		} `json:"defaultBranchRef"`
	}
	if err := json.Unmarshal(out, &v); err != nil {
		return "", errGhFailed
	}
	return v.DefaultBranchRef.Name, nil
}

// toJobPR is what the ledger keeps of p, a pull request of repo: its URL
// and the run of a failed check only when they are repo's, its check names
// in ciCheckName's charset. push is the repo the job's branch is pushed
// to: a head elsewhere makes the pull request foreign.
func toJobPR(p ghPR, repo, push ghRepo) (jobPR, bool) {
	if p.Number < 1 {
		return jobPR{}, false
	}
	out := jobPR{Number: p.Number, Repo: repo.String(), Draft: p.IsDraft}
	switch p.State {
	case "OPEN":
		out.State = prOpen
	case "MERGED":
		out.State = prMerged
	case "CLOSED":
		out.State = prClosed
	default:
		return jobPR{}, false
	}
	if ghHeadRe.MatchString(p.HeadRefOid) {
		out.Head = p.HeadRefOid[:12]
	}
	if want := fmt.Sprintf("https://%s/%s/%s/pull/%d", repo.Host, repo.Owner, repo.Name, p.Number); strings.EqualFold(p.URL, want) {
		out.URL = want
	}
	out.Foreign = p.HeadRepositoryOwner == nil || p.HeadRepository == nil ||
		!strings.EqualFold(p.HeadRepositoryOwner.Login, push.Owner) || !strings.EqualFold(p.HeadRepository.Name, push.Name) ||
		repo.Host != push.Host
	out.Checks = ciNone
	pending := false
	for _, c := range p.StatusCheckRollup {
		name, link, failed, done := c.Name, c.DetailsURL, false, true
		if c.Typename == "StatusContext" {
			name, link = c.Context, c.TargetURL
			failed = c.State == "FAILURE" || c.State == "ERROR"
			done = c.State != "PENDING" && c.State != "EXPECTED"
		} else {
			failed = slices.Contains(ghFailConclusions, c.Conclusion)
			done = c.Status == "COMPLETED"
		}
		switch {
		case failed:
			if len(out.Failing) < maxCIFailing {
				if n := ciCheckName(name); n != "" && !slices.Contains(out.Failing, n) {
					out.Failing = append(out.Failing, n)
				}
			}
			if out.FailRun == 0 {
				out.FailRun = runOf(link, repo)
			}
		case !done:
			pending = true
		}
	}
	switch {
	case len(out.Failing) > 0 || out.FailRun != 0 || hasFailed(p):
		out.Checks = ciFail
	case pending:
		out.Checks = ciPending
	case len(p.StatusCheckRollup) > 0:
		out.Checks = ciPass
	}
	return out, true
}

func hasFailed(p ghPR) bool {
	for _, c := range p.StatusCheckRollup {
		if slices.Contains(ghFailConclusions, c.Conclusion) || c.State == "FAILURE" || c.State == "ERROR" {
			return true
		}
	}
	return false
}

// runOf is the Actions run id in link when link is a page of repo.
func runOf(link string, repo ghRepo) int64 {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), repo.Host) {
		return 0
	}
	prefix := "/" + repo.Owner + "/" + repo.Name + "/actions/runs/"
	if !strings.HasPrefix(strings.ToLower(u.Path), strings.ToLower(prefix)) {
		return 0
	}
	m := ghRunRe.FindStringSubmatch(u.Path)
	if m == nil {
		return 0
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0
	}
	return n
}
