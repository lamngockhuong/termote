package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// versionRe accepts X.Y.Z with an optional pre-release (1.0.0-rc.1).
var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// updateStable is how long the new version must keep answering after its
// first healthy reply before update keeps it.
var updateStable = 1500 * time.Millisecond

// cmdUpdate installs a release beside the running one, points current at
// it and restarts the service; when the new version does not come up healthy
// it points current back and restarts the old one. It runs from a pane of
// the server it replaces: the service stops only the server process.
func (c *cli) cmdUpdate(args []string) error {
	var pin string
	var force bool
	fs := c.newFlagSet("update")
	fs.StringVar(&pin, "version", "", "")
	fs.BoolVar(&force, "force", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) > 0 {
		return usageError("usage: termote update [--version X.Y.Z] [--force]")
	}
	pin = strings.TrimPrefix(pin, "v")
	if pin != "" && !versionRe.MatchString(pin) {
		return usageError("invalid version format: %s (expected: X.Y.Z)", pin)
	}
	if c.isCheckout() {
		return errors.New("cannot update a git checkout; pull and rebuild instead (git pull && make build)")
	}
	if !c.isInstalledRelease() {
		return fmt.Errorf("update works on an install made by install.sh (%s); this binary runs from %s", c.versionsDir(), c.exe)
	}

	target := pin
	if target == "" {
		c.infof("Checking for updates...")
		if target, err = c.latestRelease(); err != nil {
			return err
		}
	}
	current := c.currentVersion()
	if current == "" {
		current = c.version
	}
	before := c.previousVersion()
	if target == current && !force {
		c.infof("Already on v%s. Use --force to reinstall.", current)
		return nil
	}
	if compareVersions(target, current) < 0 {
		c.warnf("Downgrading from v%s to v%s", current, target)
	}
	c.infof("Updating v%s -> v%s", current, target)

	// Download and verify before anything changes: a typo in --version or a
	// bad download must not touch the running server.
	if err := ensureDir(c.dataDir()); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(c.dataDir(), ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	archive, err := c.downloadVerified(target, tmp)
	if err != nil {
		return err
	}
	// --force on the running version lays it down again (a damaged copy is
	// replaced). Unix renames over the running binary; Windows refuses while
	// it runs and says so.
	if err := c.installVersion(archive, target); err != nil {
		if target == current {
			return fmt.Errorf("cannot reinstall the running v%s (%w); stop it first: termote stop", target, err)
		}
		return err
	}
	if err := c.switchCurrent(target); err != nil {
		return err
	}

	sup := c.installedSupervisor()
	if sup == nil {
		c.pruneVersions()
		c.infof("Updated to v%s. Start it with: termote start", target)
		return nil
	}
	saved, _ := c.loadConfig()
	port, pass := c.savedPort(saved), ""
	if saved != nil {
		pass = saved.Password
	}
	user := saved.authUser()
	if err := c.restartAndCheck(sup, port, user, pass, target); err == nil {
		c.pruneVersions()
		c.infof("Updated to v%s (%s); config unchanged", target, sup.Name())
		return nil
	} else {
		c.errorf("v%s did not come up: %v", target, err)
	}

	// Roll back to the version that ran before (when a forced reinstall of
	// it failed, to the one before that), and restore previous as it was.
	back := current
	if back == target {
		back = before
	}
	if back == "" || back == target || !fileExists(c.versionBinary(back)) {
		return fmt.Errorf("no previous version to roll back to; last log lines:\n%s", tailFile(c.serverLog(), 15))
	}
	c.warnf("Rolling back to v%s...", back)
	if err := c.setPointer("current", back); err != nil {
		return fmt.Errorf("roll back to v%s: %w", back, err)
	}
	if before != "" && before != back {
		c.setPointer("previous", before)
	} else {
		os.Remove(c.pointerPath("previous"))
	}
	current = back
	if err := c.restartAndCheck(sup, port, user, pass, current); err != nil {
		return fmt.Errorf("the rollback to v%s did not come up either (%v). Both versions are kept in %s.\n"+
			"Last log lines:\n%s\nRecover by hand: termote start, or reinstall one version with:\n"+
			"  curl -fsSL https://termote.ohnice.app/install.sh | TERMOTE_VERSION=%s sh",
			current, err, c.versionsDir(), tailFile(c.serverLog(), 15), current)
	}
	return fmt.Errorf("update to v%s failed; rolled back to v%s, which is running (the log is in %s)", target, current, c.serverLog())
}

// restartAndCheck restarts the server and waits until version answers
// healthy, then keeps answering: two more checks, updateStable apart, so a
// server that crashes right after its first reply is not kept.
func (c *cli) restartAndCheck(sup supervisor, port int, user, pass, version string) error {
	if err := sup.Stop(); err != nil {
		return err
	}
	if err := c.waitStopped(port, processKillWait+2*time.Second); err != nil {
		return err
	}
	if err := sup.Start(); err != nil {
		return err
	}
	if err := c.waitForServer(port, user, pass, version, serverStartWait, c.detachedExited); err != nil {
		// A version from before the saved username ignores it and still
		// serves admin, so a downgrade to one is not taken for a failure.
		if user == adminUser {
			return err
		}
		if h, code := fetchHealth(port, adminUser, pass); code != http.StatusOK || h.Status != "ok" || h.Version != version {
			return err
		}
		c.warnf("v%s ignores the saved username %q: log in as %s until you update again", version, user, adminUser)
		user = adminUser
	}
	for range 2 {
		time.Sleep(updateStable)
		if err := c.waitForServer(port, user, pass, version, time.Second, c.detachedExited); err != nil {
			return fmt.Errorf("stopped answering after it started: %w", err)
		}
	}
	return nil
}

// releaseAsset is the archive name for version on this platform. Windows on
// ARM runs the amd64 build.
func (c *cli) releaseAsset(version string) string {
	arch := c.goarch
	if c.goos == "windows" {
		arch = "amd64"
	}
	name := "termote-" + version + "-" + c.goos + "-" + arch
	if c.goos == "windows" {
		return name + ".zip"
	}
	return name + ".tar.gz"
}

// downloadVerified saves the release archive into tmp and checks it against
// its .sha256 file. A missing or wrong checksum always fails.
func (c *cli) downloadVerified(version, tmp string) (string, error) {
	name := c.releaseAsset(version)
	base := c.downloadBase + "/" + updateRepo + "/releases/download/v" + version + "/"
	c.infof("Downloading %s...", name)
	file := filepath.Join(tmp, name)
	sum, err := c.download(base+name, file)
	var he *httpError
	switch {
	case errors.As(err, &he) && he.code == http.StatusNotFound:
		return "", fmt.Errorf("release v%s has no %s: the version does not exist, or it was released a few minutes ago and is still publishing (retry then)", version, name)
	case err != nil:
		return "", fmt.Errorf("download %s: %w", name, err)
	}
	expected, err := c.expectedChecksum(base+name+".sha256", name)
	switch {
	case err != nil:
		return "", fmt.Errorf("cannot download %s.sha256 (%v); refusing to install an unverified binary", name, err)
	case expected == "":
		return "", fmt.Errorf("%s.sha256 does not list %s; refusing to install an unverified binary", name, name)
	case !strings.EqualFold(expected, sum):
		return "", fmt.Errorf("checksum mismatch for %s (expected %s, got %s); nothing was installed", name, expected, sum)
	}
	c.infof("Checksum verified")
	return file, nil
}

// httpError is a non-200 answer.
type httpError struct {
	url  string
	code int
}

func (e *httpError) Error() string { return fmt.Sprintf("GET %s: HTTP %d", e.url, e.code) }

func (c *cli) get(url string, header http.Header) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set("User-Agent", "termote/"+c.version)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, &httpError{url: url, code: resp.StatusCode}
	}
	return resp, nil
}

// maxDownloadBytes caps a downloaded release archive, and maxExtractBytes
// what all of its files add up to once unpacked (a release is about 10 MB):
// a forged archive must not fill the disk. Variables for tests.
var (
	maxDownloadBytes int64 = 256 << 20
	maxExtractBytes  int64 = 512 << 20
)

// errTooLarge is an archive, or its contents, over the caps above.
var errTooLarge = errors.New("release archive too large")

// download saves url to dst and returns its sha256.
func (c *cli) download(url, dst string) (string, error) {
	resp, err := c.get(url, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	f, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		return "", err
	}
	if n > maxDownloadBytes {
		return "", errTooLarge
	}
	return hex.EncodeToString(h.Sum(nil)), f.Close()
}

// expectedChecksum finds name in a sha256sum listing; "" if not listed.
func (c *cli) expectedChecksum(url, name string) (string, error) {
	resp, err := c.get(url, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(io.LimitReader(resp.Body, 1<<20))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return f[0], nil
		}
	}
	return "", sc.Err()
}

// extractTarball unpacks a release tarball into dir, dropping the top-level
// termote-<v>-<os>-<arch>/ directory.
func extractTarball(file, dir string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	budget := maxExtractBytes
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		rel, ok := stripTopDir(h.Name)
		if !ok {
			continue
		}
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeExtracted(tr, dst, h.FileInfo().Mode().Perm(), &budget); err != nil {
				return err
			}
		}
	}
}

// stripTopDir removes the first path element and rejects paths that would
// escape the install dir.
// A backslash is refused outright: path.Clean treats it as a plain character
// but Windows reads it as a separator ("top/..\..\x").
func stripTopDir(name string) (string, bool) {
	if strings.Contains(name, "\\") {
		return "", false
	}
	name = strings.TrimPrefix(path.Clean("/"+name), "/")
	_, rel, ok := strings.Cut(name, "/")
	if !ok || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", false
	}
	return rel, true
}

// writeExtracted writes r to dst, at most *budget bytes, and takes what it
// wrote off *budget.
func writeExtracted(r io.Reader, dst string, perm os.FileMode, budget *int64) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm|0o200)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(r, *budget+1))
	if err == nil && n > *budget {
		err = errTooLarge
	}
	if err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	*budget -= n
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// extractZip unpacks a release zip into dir, dropping the top-level
// directory, with the same path checks as extractTarball.
func extractZip(file, dir string) error {
	zr, err := zip.OpenReader(file)
	if err != nil {
		return err
	}
	defer zr.Close()
	budget := maxExtractBytes
	for _, f := range zr.File {
		rel, ok := stripTopDir(f.Name)
		if !ok {
			continue
		}
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		if !f.Mode().IsRegular() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = writeExtracted(rc, dst, f.Mode().Perm()|0o644, &budget)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// compareVersions orders X.Y.Z[-pre]; a pre-release sorts before its release.
func compareVersions(a, b string) int {
	ac, ap, _ := strings.Cut(a, "-")
	bc, bp, _ := strings.Cut(b, "-")
	if d := compareDotted(ac, bc, true); d != 0 {
		return d
	}
	switch {
	case ap == bp:
		return 0
	case ap == "":
		return 1
	case bp == "":
		return -1
	}
	return compareDotted(ap, bp, false)
}

func compareDotted(a, b string, numericOnly bool) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		if i >= len(as) {
			return -1
		}
		if i >= len(bs) {
			return 1
		}
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		if aerr == nil && berr == nil {
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
			continue
		}
		if numericOnly {
			return strings.Compare(as[i], bs[i])
		}
		// Numeric identifiers sort before alphanumeric ones (semver).
		switch {
		case aerr == nil:
			return -1
		case berr == nil:
			return 1
		}
		if d := strings.Compare(as[i], bs[i]); d != 0 {
			return d
		}
	}
	return 0
}
