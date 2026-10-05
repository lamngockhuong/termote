package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Releases from firstSignedVersion on carry checksums.txt.sig: an Ed25519
// signature of checksums.txt, made by the release workflow with a key that
// only a release approved in the `release` environment can use. The public
// key is pinned here, so a release published from a pushed tag, or an asset
// replaced after publishing, fails the check even with matching checksums:
// those are generated in the same run as the archives.

// firstSignedVersion is the first release whose checksums are signed. An
// older one (`update --version`) is checked against its sha256 alone.
const firstSignedVersion = "1.10.0"

// releasePublicKey is the raw Ed25519 public key, base64. A variable for
// tests.
var releasePublicKey = "Or7k5razFbKPXHHupRqpC3u1QUJ1U6ESJghM9us9PaA="

const (
	checksumsName    = "checksums.txt"
	checksumsSigName = "checksums.txt.sig"
	// maxChecksumsSize caps checksums.txt (a few hundred bytes).
	maxChecksumsSize = 64 << 10
)

var errBadSignature = errors.New("checksums.txt is not signed by the Termote release key")

// releaseSigned reports whether version is one whose checksums are signed.
func releaseSigned(version string) bool {
	return compareVersions(version, firstSignedVersion) >= 0
}

// verifyChecksums checks sig (base64 or raw, as `openssl pkeyutl -sign`
// writes it raw) over checksums with the pinned key.
func verifyChecksums(checksums, sig []byte) error {
	key, err := base64.StdEncoding.DecodeString(releasePublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("no valid release public key in this build")
	}
	if len(sig) != ed25519.SignatureSize {
		if dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig))); err == nil {
			sig = dec
		}
	}
	if len(sig) != ed25519.SignatureSize || !ed25519.Verify(ed25519.PublicKey(key), checksums, sig) {
		return errBadSignature
	}
	return nil
}

// checksumOf finds name in a sha256sum listing; "" if not listed.
func checksumOf(listing []byte, name string) string {
	sc := bufio.NewScanner(bytes.NewReader(listing))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return f[0]
		}
	}
	return ""
}

// signedChecksums downloads checksums.txt and its signature from base (the
// release's download URL, ending in /) and returns the listing once the
// signature checks out.
func (c *cli) signedChecksums(base string) ([]byte, error) {
	listing, err := c.fetchSmall(base+checksumsName, maxChecksumsSize)
	if err != nil {
		return nil, fmt.Errorf("cannot download %s: %w", checksumsName, err)
	}
	sig, err := c.fetchSmall(base+checksumsSigName, 1<<10)
	if err != nil {
		return nil, fmt.Errorf("cannot download %s: %w", checksumsSigName, err)
	}
	if err := verifyChecksums(listing, sig); err != nil {
		return nil, err
	}
	return listing, nil
}

// fetchSmall reads url whole, refusing more than limit bytes.
func (c *cli) fetchSmall(url string, limit int64) ([]byte, error) {
	resp, err := c.get(url, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return b, nil
}

// imageDigestName is the release asset naming the image the release pushed,
// by digest; checksums.txt lists it, so it is covered by the signature.
const imageDigestName = "image-digest.txt"

// signedImageRef returns the image of release version by digest, as its
// signed checksums vouch for it: a tag on the registry can be moved, a
// digest names one image.
func (c *cli) signedImageRef(version string) (string, error) {
	base := c.downloadBase + "/" + updateRepo + "/releases/download/v" + version + "/"
	listing, err := c.signedChecksums(base)
	if err != nil {
		return "", fmt.Errorf("%v; refusing to run the v%s image", err, version)
	}
	body, err := c.fetchSmall(base+imageDigestName, 1<<10)
	if err != nil {
		return "", fmt.Errorf("cannot download %s: %w", imageDigestName, err)
	}
	sum := sha256.Sum256(body)
	if want := checksumOf(listing, imageDigestName); want == "" || !strings.EqualFold(want, hex.EncodeToString(sum[:])) {
		return "", fmt.Errorf("%s does not match the signed %s; refusing to run the v%s image", imageDigestName, checksumsName, version)
	}
	ref := strings.TrimSpace(string(body))
	digest, ok := strings.CutPrefix(ref, containerImage+"@sha256:")
	if !ok || len(digest) != 64 || strings.Trim(digest, "0123456789abcdef") != "" {
		return "", fmt.Errorf("%s names %q, not a digest of %s", imageDigestName, ref, containerImage)
	}
	return ref, nil
}
