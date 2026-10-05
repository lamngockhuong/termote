package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// useTestReleaseKey pins a key made for the test and returns its private
// half, which signs the fake releases.
func useTestReleaseKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	old := releasePublicKey
	releasePublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { releasePublicKey = old })
	return priv
}

// publishSigned publishes version with a checksums.txt and its signature by
// priv: mode "good", "nosig", "otherkey", "unlisted" (the archive left out
// of checksums.txt), "wrongsum", "base64" (the signature as base64 text).
func (g *fakeReleases) publishSigned(t *testing.T, version string, priv ed25519.PrivateKey, mode string) {
	t.Helper()
	g.publish(t, version, "none")
	name := "termote-" + version + "-linux-amd64.tar.gz"
	if g.goos == "windows" {
		name = "termote-" + version + "-windows-amd64.zip"
	}
	sum := sha(g.assets["v"+version+"/"+name])
	switch mode {
	case "unlisted":
		name = "termote-" + version + "-darwin-arm64.tar.gz"
	case "wrongsum":
		sum = strings.Repeat("0", 64)
	}
	listing := []byte(sum + "  " + name + "\n" + strings.Repeat("1", 64) + "  other.zip\n")
	g.assets["v"+version+"/"+checksumsName] = listing
	if mode == "otherkey" {
		_, priv, _ = ed25519.GenerateKey(rand.Reader)
	}
	sig := ed25519.Sign(priv, listing)
	switch mode {
	case "nosig":
		return
	case "base64":
		sig = []byte(base64.StdEncoding.EncodeToString(sig) + "\n")
	}
	g.assets["v"+version+"/"+checksumsSigName] = sig
}

func TestUpdateChecksTheReleaseSignature(t *testing.T) {
	for _, mode := range []string{"good", "base64"} {
		t.Run(mode, func(t *testing.T) {
			tc, gh, _ := setupUpdate(t)
			gh.publishSigned(t, "1.10.0", useTestReleaseKey(t), mode)
			if code := tc.main([]string{"update", "--version", "1.10.0"}); code != 0 {
				t.Fatalf("code %d stderr %s", code, tc.stderr.String())
			}
			if tc.currentVersion() != "1.10.0" || !strings.Contains(tc.stdout.String(), "Signature and checksum verified") {
				t.Fatalf("current %s\n%s", tc.currentVersion(), tc.stdout.String())
			}
		})
	}
}

// A signed release whose signature is missing or made by another key (a
// release from a pushed tag, an asset replaced later), or whose signed
// listing does not vouch for the archive, installs nothing.
func TestUpdateRefusesUnsignedReleases(t *testing.T) {
	for mode, want := range map[string]string{
		"nosig":    "cannot download checksums.txt.sig",
		"otherkey": "not signed by the Termote release key",
		"unlisted": "does not list",
		"wrongsum": "checksum mismatch",
	} {
		t.Run(mode, func(t *testing.T) {
			tc, gh, svc := setupUpdate(t)
			gh.publishSigned(t, "1.10.0", useTestReleaseKey(t), mode)
			// The .sha256 file matching does not make up for it.
			gh.assets["v1.10.0/termote-1.10.0-linux-amd64.tar.gz.sha256"] = []byte(sha(gh.assets["v1.10.0/termote-1.10.0-linux-amd64.tar.gz"]) + "  termote-1.10.0-linux-amd64.tar.gz\n")
			if code := tc.main([]string{"update", "--version", "1.10.0"}); code != 1 || !strings.Contains(tc.stderr.String(), want) {
				t.Fatalf("code %d stderr %s", code, tc.stderr.String())
			}
			if fileExists(filepath.Join(tc.versionsDir(), "1.10.0")) || tc.currentVersion() != "1.0.0" || len(svc.calls) != 0 {
				t.Fatalf("an unsigned release changed the install (calls %v)", svc.calls)
			}
		})
	}
	// No checksums.txt at all.
	tc, gh, _ := setupUpdate(t)
	priv := useTestReleaseKey(t)
	gh.publishSigned(t, "1.10.0", priv, "good")
	delete(gh.assets, "v1.10.0/"+checksumsName)
	if code := tc.main([]string{"update", "--version", "1.10.0"}); code != 1 || !strings.Contains(tc.stderr.String(), "cannot download checksums.txt") {
		t.Fatalf("code %d stderr %s", code, tc.stderr.String())
	}
}

// A release before firstSignedVersion is checked against its sha256 alone,
// and the user is told so.
func TestUpdateToAnOlderUnsignedRelease(t *testing.T) {
	tc, _, _ := setupUpdate(t)
	if code := tc.main([]string{"update"}); code != 0 {
		t.Fatalf("code %d stderr %s", code, tc.stderr.String())
	}
	if !strings.Contains(tc.stdout.String()+tc.stderr.String(), "v1.0.1 predates signed releases") {
		t.Fatalf("not told:\n%s%s", tc.stdout.String(), tc.stderr.String())
	}
}

func TestVerifyChecksums(t *testing.T) {
	priv := useTestReleaseKey(t)
	msg := []byte("abc  termote.tar.gz\n")
	if err := verifyChecksums(msg, ed25519.Sign(priv, msg)); err != nil {
		t.Fatal(err)
	}
	for name, sig := range map[string][]byte{
		"short":     []byte("abc"),
		"other msg": ed25519.Sign(priv, []byte("x")),
		"not b64":   []byte(strings.Repeat("!", 88)),
	} {
		if err := verifyChecksums(msg, sig); err != errBadSignature {
			t.Errorf("%s: %v", name, err)
		}
	}
	releasePublicKey = "not a key"
	if err := verifyChecksums(msg, ed25519.Sign(priv, msg)); err == nil || err == errBadSignature {
		t.Errorf("bad pinned key: %v", err)
	}
	if !releaseSigned(firstSignedVersion) || !releaseSigned("2.0.0") || releaseSigned("1.9.0") {
		t.Error("releaseSigned")
	}
	if checksumOf([]byte("x  *a.zip\nbroken\n"), "a.zip") != "x" || checksumOf(nil, "a.zip") != "" {
		t.Error("checksumOf")
	}
}

func TestFetchSmallRefusesLargeFiles(t *testing.T) {
	tc, gh, _ := setupUpdate(t)
	gh.assets["big"] = []byte(strings.Repeat("a", 2048))
	if _, err := tc.fetchSmall(tc.downloadBase+"/"+updateRepo+"/releases/download/big", 1024); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("err %v", err)
	}
}

// signedImageRelease serves release 1.10.0 to cc with checksums.txt signed
// by priv, listing image-digest.txt (holding ref) unless listed is false.
func signedImageRelease(t *testing.T, cc *containerCLI, ref string, listed bool, priv ed25519.PrivateKey) {
	t.Helper()
	gh := &fakeReleases{assets: map[string][]byte{}, goos: "linux"}
	listing := strings.Repeat("1", 64) + "  termote-1.10.0-linux-amd64.tar.gz\n"
	if listed {
		listing += sha([]byte(ref+"\n")) + "  " + imageDigestName + "\n"
	}
	gh.assets["v1.10.0/"+checksumsName] = []byte(listing)
	gh.assets["v1.10.0/"+checksumsSigName] = ed25519.Sign(priv, []byte(listing))
	gh.assets["v1.10.0/"+imageDigestName] = []byte(ref + "\n")
	srv := httptest.NewServer(gh)
	t.Cleanup(srv.Close)
	cc.http, cc.downloadBase = srv.Client(), srv.URL
	cc.version = "1.10.0"
}

// A signed release runs its image by the digest its signed checksums vouch
// for, never by the tag, which the registry lets anyone with push rights move.
func TestContainerUpRunsTheSignedDigest(t *testing.T) {
	cc := newContainerCLI(t)
	ref := containerImage + "@sha256:" + strings.Repeat("ab", 32)
	signedImageRelease(t, cc, ref, true, useTestReleaseKey(t))
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t)), "--workspace", t.TempDir()}); code != 0 {
		t.Fatalf("code %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
	if !cc.runner.called("docker pull "+ref) || cc.runArgs[len(cc.runArgs)-1] != ref {
		t.Fatalf("not run by digest: calls %v, run %v", cc.runner.calls, cc.runArgs)
	}
}

func TestContainerUpRefusesAnUnvouchedImage(t *testing.T) {
	digest := containerImage + "@sha256:" + strings.Repeat("ab", 32)
	for name, c := range map[string]struct {
		ref, want string
		listed    bool
		otherKey  bool
	}{
		"bad signature": {digest, "not signed by the Termote release key", true, true},
		"unlisted":      {digest, "does not match the signed checksums.txt", false, false},
		"a tag":         {containerImage + ":latest", "not a digest of", true, false},
		"other image":   {"docker.io/evil/termote@sha256:" + strings.Repeat("ab", 32), "not a digest of", true, false},
		"short digest":  {containerImage + "@sha256:abc", "not a digest of", true, false},
	} {
		t.Run(name, func(t *testing.T) {
			cc := newContainerCLI(t)
			priv := useTestReleaseKey(t)
			if c.otherKey {
				_, priv, _ = ed25519.GenerateKey(rand.Reader)
			}
			signedImageRelease(t, cc, c.ref, c.listed, priv)
			if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t)), "--workspace", t.TempDir()}); code != 1 || !strings.Contains(cc.stderr.String(), c.want) {
				t.Fatalf("code %d stderr %s", code, cc.stderr.String())
			}
			if cc.runArgs != nil || slices.ContainsFunc(cc.runner.calls, func(s string) bool { return strings.HasPrefix(s, "docker pull") }) {
				t.Fatalf("pulled or ran: %v", cc.runner.calls)
			}
		})
	}
}

// The digest file itself missing from a signed release: nothing runs.
func TestContainerUpWithoutImageDigest(t *testing.T) {
	cc := newContainerCLI(t)
	priv := useTestReleaseKey(t)
	gh := &fakeReleases{assets: map[string][]byte{}, goos: "linux"}
	listing := []byte(strings.Repeat("1", 64) + "  termote-1.10.0-linux-amd64.tar.gz\n")
	gh.assets["v1.10.0/"+checksumsName] = listing
	gh.assets["v1.10.0/"+checksumsSigName] = ed25519.Sign(priv, listing)
	srv := httptest.NewServer(gh)
	t.Cleanup(srv.Close)
	cc.http, cc.downloadBase, cc.version = srv.Client(), srv.URL, "1.10.0"
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t)), "--workspace", t.TempDir()}); code != 1 || !strings.Contains(cc.stderr.String(), "cannot download image-digest.txt") {
		t.Fatalf("code %d stderr %s", code, cc.stderr.String())
	}
}

// installerReleaseKey is the public key install.sh pins, from its RELEASE_KEY
// block, as raw base64.
func installerReleaseKey(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "scripts", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	_, rest, ok := strings.Cut(string(b), "RELEASE_KEY='")
	pemText, _, ok2 := strings.Cut(rest, "'")
	block, _ := pem.Decode([]byte(pemText))
	if !ok || !ok2 || block == nil {
		t.Fatalf("install.sh holds no RELEASE_KEY PEM: %q", pemText)
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	pub, isEd := key.(ed25519.PublicKey)
	if err != nil || !isEd {
		t.Fatalf("install.sh RELEASE_KEY is not an Ed25519 public key: %v", err)
	}
	return base64.StdEncoding.EncodeToString(pub)
}

// The CLI and install.sh pin one key (the release workflow checks its
// signature against install.sh's): a placeholder or a mismatch fails here,
// before a build could ship it.
func TestReleaseKeyMatchesInstaller(t *testing.T) {
	if got := installerReleaseKey(t); got != releasePublicKey {
		t.Fatalf("install.sh pins %s, the CLI %s", got, releasePublicKey)
	}
}

// A signature made the way the release workflow makes it (openssl pkeyutl,
// raw output) verifies here.
func TestVerifyChecksumsAcceptsOpenSSLSignatures(t *testing.T) {
	if out, err := exec.Command("openssl", "version").Output(); err != nil || !strings.HasPrefix(string(out), "OpenSSL 3") {
		t.Skip("needs OpenSSL 3")
	}
	dir := t.TempDir()
	key, msg, sig := filepath.Join(dir, "k.pem"), filepath.Join(dir, "checksums.txt"), filepath.Join(dir, "checksums.txt.sig")
	if err := os.WriteFile(msg, []byte("abc  termote-1.10.0-linux-amd64.tar.gz\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"genpkey", "-algorithm", "ed25519", "-out", key},
		{"pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", msg, "-out", sig},
	} {
		if out, err := exec.Command("openssl", args...).CombinedOutput(); err != nil {
			t.Fatalf("openssl %v: %v %s", args, err, out)
		}
	}
	pubPEM, err := exec.Command("openssl", "pkey", "-in", key, "-pubout").Output()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(pubPEM)
	pub, _ := x509.ParsePKIXPublicKey(block.Bytes)
	old := releasePublicKey
	releasePublicKey = base64.StdEncoding.EncodeToString(pub.(ed25519.PublicKey))
	t.Cleanup(func() { releasePublicKey = old })
	m, _ := os.ReadFile(msg)
	s, _ := os.ReadFile(sig)
	if err := verifyChecksums(m, s); err != nil {
		t.Fatal(err)
	}
}

// A reply cut short (the connection drops) is an error, never a shorter file.
func TestFetchSmallCutShort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("short"))
	}))
	t.Cleanup(srv.Close)
	tc := newTestCLI(t, "linux")
	tc.http = srv.Client()
	if _, err := tc.fetchSmall(srv.URL+"/checksums.txt", 1024); err == nil {
		t.Fatal("cut-short reply accepted")
	}
}
