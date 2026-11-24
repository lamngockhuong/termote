package main

import (
	"context"
	"testing"
)

func TestIsSSHRemote(t *testing.T) {
	for raw, want := range map[string]bool{
		"git@work.github.com:o/r.git":         true,
		"work.github.com:o/r":                 true,
		"ssh://git@github.com-work/o/r.git":   true,
		"git+ssh://git@github.com/o/r.git":    true,
		"https://github.com/o/r.git":          false,
		"http://github.com/o/r.git":           false,
		"file:///srv/o/r.git":                 false,
		"/srv/o/r.git":                        false,
		" git@work.github.com:o/r.git\n":      true,
		"https://work.github.com:443/o/r.git": false,
	} {
		if got := isSSHRemote(raw); got != want {
			t.Errorf("isSSHRemote(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestSSHConfigHostName(t *testing.T) {
	for out, want := range map[string]string{
		"user git\nhostname github.com\nport 22\n": "github.com",
		"hostname GitHub.COM\n":                    "github.com",
		"hostname ssh.github.com\nport 443\n":      "github.com",
		"hostname ghe.example.com\n":               "ghe.example.com",
		"hostname -oProxyCommand=x\n":              "",
		"hostname a b\n":                           "",
		"user git\nport 22\n":                      "",
		"hostnamex github.com\n":                   "",
		"":                                         "",
	} {
		if got := sshConfigHostName([]byte(out)); got != want {
			t.Errorf("sshConfigHostName(%q) = %q, want %q", out, got, want)
		}
	}
}

// A host that is not one (an option, a space) never reaches ssh.
func TestSSHHostNameRefusesNonHost(t *testing.T) {
	for _, h := range []string{"-oProxyCommand=x", "a b", "", "a/b"} {
		if got := sshHostName(context.Background(), h); got != "" {
			t.Errorf("sshHostName(%q) = %q", h, got)
		}
	}
}
