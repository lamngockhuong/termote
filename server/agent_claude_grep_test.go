package main

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

// A Grep over a directory whose glob or type can pick a sensitive file, and
// whose output shows lines, is marked like a Grep of that file.
func TestClaudeGrepOverDirectoryMarkedSensitive(t *testing.T) {
	grep := func(in string) bool {
		rows := `{"type":"assistant","uuid":"a","message":{"content":[{"type":"tool_use","id":"t","name":"Grep","input":` + in + `}]}}` + "\n"
		es, _ := claudeJournal{}.Parse(strings.NewReader(rows), 0)
		if len(es) != 1 || len(es[0].Parts) != 1 {
			t.Fatalf("%s: entries = %+v", in, es)
		}
		return es[0].Parts[0].sensitive
	}
	for _, c := range []struct {
		in   string
		want bool
	}{
		{`{"pattern":"K","path":"/r","glob":".env*","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":"**/.env.local","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":"*.{ts,pem}","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":"secrets.*","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":"*","output_mode":"content"}`, false},
		{`{"pattern":"K","path":"/r","glob":".ssh/*","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":"*.go *.ENV","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","type":"tf","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/home/u/.ssh","output_mode":"content"}`, true},
		{`{"pattern":"K","path":"/r","glob":".env*"}`, false},
		{`{"pattern":"K","path":"/r","glob":".env*","output_mode":"files_with_matches"}`, false},
		{`{"pattern":"K","path":"/r","glob":".env*","output_mode":"count"}`, false},
		{`{"pattern":"K","path":"/r","glob":"*.go","output_mode":"content"}`, false},
		{`{"pattern":"K","path":"/r","glob":"!.env*","output_mode":"content"}`, false},
		{`{"pattern":"\\.env","path":"/r","output_mode":"content"}`, false},
		{`{"pattern":"K","path":"/r","type":"go","output_mode":"content"}`, false},
		{`{"pattern":"K","path":"/r","output_mode":"content"}`, false},
		{`{"pattern":"K","path":"/r/.env","glob":"*.go"}`, true},
	} {
		if got := grep(c.in); got != c.want {
			t.Errorf("%s: sensitive = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestGlobMaySelectSensitive(t *testing.T) {
	for _, c := range []struct {
		glob string
		want bool
	}{
		{".env", true}, {".env*", true}, {"*.env", true}, {".e?v", true}, {".[e]nv", true}, {"[.]env", true},
		{"[!a]env", true}, {".env.{local,prod}", true}, {"{a,{b,.env}}", true}, {"*.PEM", true},
		{"secrets.*", true}, {"**/secrets.yaml", true}, {"config/credentials.json", true},
		{".aws/config", true}, {".config/gh/hosts.yml", true}, {"*/.kube/*", true}, {".ssh/**", true},
		{"*.{go", true}, {"[abc", true}, {"x\\", true},
		{"*", false}, {"**", false}, {"src/**", false}, {"*.go", false}, {"*.{ts,tsx}", false},
		{"src/**/*.rs", false}, {"**/*.json", false}, {"README.md", false}, {"*.envy", false},
		{"[!.]env", false}, {"gh/*.go", false}, {"!*.env", false}, {"!.env, *.go", false},
		{"docs/*.md,*.txt", false},
		// Named only in part: not keyed.
		{"*.local", false}, {"id_*", false},
	} {
		if got := globMaySelectSensitive(c.glob); got != c.want {
			t.Errorf("globMaySelectSensitive(%q) = %v, want %v", c.glob, got, c.want)
		}
	}
}

// sensitiveGrepTypes is every ripgrep type one of whose globs can select a
// sensitive file, checked against the rg on PATH when there is one.
func TestSensitiveGrepTypes(t *testing.T) {
	out, err := exec.Command("rg", "--type-list").Output()
	if err != nil {
		t.Skip("rg not installed")
	}
	var want []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, globs, ok := strings.Cut(line, ": ")
		if !ok {
			t.Fatalf("type line %q", line)
		}
		for _, g := range strings.Split(globs, ", ") {
			if globMaySelectSensitive(g) {
				want = append(want, name)
				break
			}
		}
	}
	got := slices.Clone(sensitiveGrepTypes)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("sensitiveGrepTypes = %q, rg says %q", got, want)
	}
}
