package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
)

// versionRe accepts X.Y.Z with an optional pre-release (1.0.0-rc.1).
var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

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
		return errors.New("cannot update from a git checkout; this command is for installed releases (~/.termote)")
	}

	target := pin
	if pin != "" {
		c.infof("Target version: v%s", target)
	} else {
		c.infof("Checking for updates...")
		if target, err = c.latestVersion(); err != nil {
			return fmt.Errorf("failed to fetch latest version from GitHub: %w", err)
		}
		c.infof("Latest version: v%s", target)
	}
	if target == c.version && !force {
		c.infof("Already on v%s. Use --force to reinstall.", c.version)
		return nil
	}
	if compareVersions(target, c.version) < 0 {
		c.warnf("Downgrading from v%s to v%s", c.version, target)
	}
	if target != c.version {
		c.infof("Current version: v%s", c.version)
		c.infof("Updating to: v%s", target)
	} else {
		c.infof("Force reinstalling v%s", c.version)
	}

	saved, err := c.loadConfig()
	if err != nil {
		return err
	}
	if saved == nil {
		return fmt.Errorf("no saved config found at %s; run 'termote install' first", c.configFile())
	}
	mode := saved.Mode
	if mode == "" {
		mode = "native"
	}

	// Download and verify before stopping anything: a typo in --version or a
	// network error must not leave a remote user without their server.
	tmp, err := os.MkdirTemp("", "termote-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	file, err := c.downloadVerified(target, tmp)
	if err != nil {
		return err
	}

	c.infof("Stopping services...")
	c.stopNative()
	c.stopContainers(false)

	c.infof("Extracting...")
	if err := extractTarball(file, c.projectDir); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(c.projectDir, ".version"), []byte(target), 0o644); err != nil {
		return err
	}
	c.infof("Updated to v%s", target)
	c.infof("Re-installing with saved config (mode=%s)...", mode)
	fmt.Fprintln(c.out)
	// Hand over to the new shim so no code of this binary keeps running.
	shim := c.shimPath()
	if c.goos != "windows" {
		os.Chmod(shim, 0o755)
	}
	return c.execShim(shim, []string{"install", mode})
}

func (c *cli) get(url string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "termote/"+c.version)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return resp, nil
}

// latestVersion reads releases/latest, which skips pre-releases.
func (c *cli) latestVersion() (string, error) {
	resp, err := c.get(c.apiBase + "/repos/" + updateRepo + "/releases/latest")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return "", err
	}
	v := strings.TrimPrefix(rel.TagName, "v")
	if !versionRe.MatchString(v) {
		return "", fmt.Errorf("unexpected tag %q", rel.TagName)
	}
	return v, nil
}

// downloadVerified saves the release tarball into tmp and checks it against
// checksums.txt.
func (c *cli) downloadVerified(version, tmp string) (string, error) {
	tarball := "termote-v" + version + ".tar.gz"
	base := c.downloadBase + "/" + updateRepo + "/releases/download/v" + version + "/"
	c.infof("Downloading v%s...", version)
	file := filepath.Join(tmp, tarball)
	sum, err := c.download(base+tarball, file)
	if err != nil {
		return "", fmt.Errorf("download failed (does v%s exist?): %w", version, err)
	}

	c.infof("Verifying checksum...")
	expected, err := c.expectedChecksum(base+"checksums.txt", tarball)
	switch {
	case err != nil:
		c.warnf("Could not download checksums, skipping verification")
	case expected == "":
		c.warnf("Checksum not found for %s, skipping verification", tarball)
	case !strings.EqualFold(expected, sum):
		return "", fmt.Errorf("checksum mismatch! Expected: %s, Got: %s", expected, sum)
	default:
		c.infof("Checksum verified")
	}
	return file, nil
}

// download saves url to dst and returns its sha256.
func (c *cli) download(url, dst string) (string, error) {
	resp, err := c.get(url)
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
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), f.Close()
}

// expectedChecksum finds name in a sha256sum listing; "" if not listed.
func (c *cli) expectedChecksum(url, name string) (string, error) {
	resp, err := c.get(url)
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

// extractTarball unpacks a release tarball over dir, dropping the top-level
// termote-vX.Y.Z/ directory. Files outside the tarball (the config, logs)
// are kept.
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
			if err := writeExtracted(tr, dst, h.FileInfo().Mode().Perm()); err != nil {
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

func writeExtracted(r io.Reader, dst string, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm|0o200)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, r); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return renameOver(tmp, dst)
}

// cleanupReplacedBinaries deletes executables Windows could only rename
// aside during an update; ones still running stay until the next run.
func (c *cli) cleanupReplacedBinaries() {
	for _, dir := range []string{c.projectDir, filepath.Join(c.projectDir, "server")} {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.old-*"))
		for _, m := range matches {
			os.Remove(m)
		}
	}
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
