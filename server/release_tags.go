package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// stableTagRe is a release tag update and the installer consider: vX.Y.Z,
// no pre-release (those are only installed when named).
var stableTagRe = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)

// newestStable picks the highest stable version at or above 1.0.0 from tag
// names. releases/latest is not used: it can name a 0.x release, and the
// installer uses this same rule.
func newestStable(tags []string) string {
	best := ""
	for _, t := range tags {
		if !stableTagRe.MatchString(t) {
			continue
		}
		v := strings.TrimPrefix(t, "v")
		if compareVersions(v, "1.0.0") < 0 {
			continue
		}
		if best == "" || compareVersions(v, best) > 0 {
			best = v
		}
	}
	return best
}

// latestRelease asks GitHub for the tags and returns the newest stable
// version. A token in GH_TOKEN or GITHUB_TOKEN only raises the rate limit.
func (c *cli) latestRelease() (string, error) {
	header := http.Header{"Accept": {"application/vnd.github+json"}}
	token := c.getenv("GH_TOKEN")
	if token == "" {
		token = c.getenv("GITHUB_TOKEN")
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.get(c.apiBase+"/repos/"+updateRepo+"/tags?per_page=100", header)
	var he *httpError
	switch {
	case errors.As(err, &he) && (he.code == http.StatusForbidden || he.code == http.StatusTooManyRequests):
		return "", fmt.Errorf("GitHub's API rate limit says no (HTTP %d); set GH_TOKEN to a token with no scopes, wait an hour, or name the version: termote update --version X.Y.Z", he.code)
	case err != nil:
		return "", fmt.Errorf("cannot list the releases on GitHub (%v); name the version instead: termote update --version X.Y.Z", err)
	}
	defer resp.Body.Close()
	var tags []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&tags); err != nil {
		return "", fmt.Errorf("read the tag list: %w", err)
	}
	names := make([]string, len(tags))
	for i, t := range tags {
		names[i] = t.Name
	}
	v := newestStable(names)
	if v == "" {
		return "", errors.New("no 1.x release found on GitHub; name one with: termote update --version X.Y.Z")
	}
	return v, nil
}
