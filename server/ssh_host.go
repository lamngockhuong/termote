package main

import (
	"bufio"
	"bytes"
	"context"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

// sshHostTimeout bounds one ssh -G.
const sshHostTimeout = 5 * time.Second

// isSSHRemote: raw is a remote URL git reaches over ssh (ssh://, git+ssh://
// or the scp form host:owner/repo), not https or http.
func isSSHRemote(raw string) bool {
	raw = strings.TrimSpace(raw)
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
		return u.Scheme == "ssh" || u.Scheme == "git+ssh"
	}
	return !strings.Contains(raw, "://") && scpURLRe.MatchString(raw)
}

// sshHostName is the host ssh connects to for host, as ssh -G prints it
// from the user's ssh config (gh reads a remote's alias the same way), or
// "" when ssh is missing, fails, or names no valid host. host is a
// parseRemoteURL host (ghHostRe: never an option) and goes after --; ssh
// only prints its configuration, it connects to nothing.
func sshHostName(ctx context.Context, host string) string {
	if !ghHostRe.MatchString(host) {
		return ""
	}
	bin, err := exec.LookPath("ssh")
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, sshHostTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-G", "--", host)
	cmd.Dir = os.TempDir()
	cmd.Env = sshHostEnv()
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return sshConfigHostName(out)
}

// sshHostEnv is the server environment without git or Termote variables.
func sshHostEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if isTermoteEnv(kv) || len(k) >= 4 && strings.EqualFold(k[:4], "GIT_") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// sshConfigHostName reads the hostname line of ssh -G's output, lower case,
// with ssh.github.com (SSH over 443) as github.com; "" when there is none
// or it is not a valid host.
func sshConfigHostName(out []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), " ")
		if !ok || !strings.EqualFold(k, "hostname") {
			continue
		}
		h := strings.ToLower(strings.TrimSpace(v))
		if !ghHostRe.MatchString(h) {
			return ""
		}
		if h == "ssh.github.com" {
			h = "github.com"
		}
		return h
	}
	return ""
}
