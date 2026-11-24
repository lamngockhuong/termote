package main

import (
	"os"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// A string in single quotes, as biome writes the PWA's TypeScript
var tsStringRe = regexp.MustCompile(`'([^'\n]*)'`)

// The termote commands the Plan's setup sheet tells the user to copy
// (pwa/src/utils/orchestrator-setup.ts) must exist, with their flags and
// subcommands: the sheet is static, so nothing else notices a rename.
func TestOrchestratorSetupCommandsExist(t *testing.T) {
	src, err := os.ReadFile("../pwa/src/utils/orchestrator-setup.ts")
	if err != nil {
		t.Skipf("no PWA source here: %v", err)
	}
	found := map[string][]string{}
	var subs []string
	for _, s := range tsStringRe.FindAllStringSubmatch(string(src), -1) {
		for _, m := range termoteCmdRe.FindAllStringSubmatch(s[1], -1) {
			found[m[1]] = append(found[m[1]], flagRe.FindAllString(m[2], -1)...)
			subs = append(subs, m[1]+" "+firstWord(m[2]))
		}
	}
	// Not silently green when the file changes shape
	for _, want := range []string{"skills install", "skills status"} {
		if !slices.Contains(subs, want) {
			t.Fatalf("termote %s not found in orchestrator-setup.ts: %v", want, subs)
		}
	}
	checkTermoteInvocations(t, "the Plan's setup sheet", found)
	checkSubcommands(t, subs)
}

// checkSubcommands fails t for each "<cmd> <sub>" whose sub is not a word of
// the entry of cmd in termote help (its first line and those under it).
func checkSubcommands(t *testing.T, subs []string) {
	t.Helper()
	tc := newTestCLI(t, runtime.GOOS)
	tc.printHelp()
	help := strings.Split(tc.stdout.String(), "\n")
	for _, s := range subs {
		cmd, sub, _ := strings.Cut(s, " ")
		if sub == "" || strings.HasPrefix(sub, "-") {
			continue
		}
		entry := ""
		for i, line := range help {
			if m := helpCmdRe.FindStringSubmatch(line); m == nil || m[1] != cmd {
				continue
			}
			entry = line
			for _, next := range help[i+1:] {
				if !strings.HasPrefix(next, "    ") {
					break
				}
				entry += " " + next
			}
			break
		}
		if !regexp.MustCompile(`\b` + regexp.QuoteMeta(sub) + `\b`).MatchString(entry) {
			t.Errorf("the Plan's setup sheet runs termote %s %s, which help does not list", cmd, sub)
		}
	}
}

// firstWord returns the first word of s, or "" when it has none.
func firstWord(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return ""
}
