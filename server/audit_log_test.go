package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every value is quoted: a name holding a quote, an "=" or a space never
// passes for another key, and a line break never starts another line.
func TestAuditLine(t *testing.T) {
	got := auditLine("pair", "id", "0123456789abcdef", "name", `a" by="password`, "n", 3, "cascade", []string{"x", "y"}, "dangling")
	want := `audit: pair id="0123456789abcdef" name="a\" by=\"password" n="3" cascade="x,y"`
	if got != want {
		t.Errorf("auditLine =\n%s\nwant\n%s", got, want)
	}
	if line := auditLine("pair", "name", "a\nb x=1"); strings.Contains(line, "\n") || strings.Count(line, "=") != 2 {
		t.Errorf("line break or key passed through: %q", line)
	}
	if auditBy(authInfo{Kind: authDevice, DeviceID: "ab"}) != "device:ab" || auditBy(authInfo{Kind: authSession}) != "password" {
		t.Error("auditBy")
	}
	if r := httptest.NewRequest("GET", "/", nil); requestIP(r) != "192.0.2.1" {
		t.Errorf("requestIP = %q", requestIP(r))
	}
	if r := (&http.Request{RemoteAddr: "pipe"}); requestIP(r) != "pipe" {
		t.Errorf("requestIP without a port = %q", requestIP(r))
	}
	if auditUntil(nil) != "never" {
		t.Error("auditUntil(nil)")
	}
}
