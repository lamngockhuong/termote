package main

import (
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestHelpAgentPrintsGuide(t *testing.T) {
	tc := newTestCLI(t, runtime.GOOS)
	if code := tc.main([]string{"help", "agent"}); code != 0 {
		t.Fatalf("help agent: code %d, err %q", code, tc.stderr.String())
	}
	if tc.stdout.String() != agentGuide {
		t.Fatalf("help agent printed something else than the embedded guide")
	}
	if tc.stderr.Len() != 0 {
		t.Fatalf("help agent wrote to stderr: %q", tc.stderr.String())
	}
	if !strings.HasPrefix(agentGuide, "# Termote") {
		t.Fatalf("embedded guide does not start with its title: %q", agentGuide[:min(len(agentGuide), 40)])
	}
}

func TestHelpFlagsStillPrintHelp(t *testing.T) {
	for _, arg := range []string{"help", "-h", "--help"} {
		tc := newTestCLI(t, runtime.GOOS)
		if code := tc.main([]string{arg}); code != 0 || !strings.Contains(tc.stdout.String(), "help agent") {
			t.Fatalf("%s: code %d, out %q", arg, code, tc.stdout.String())
		}
	}
}

func TestHelpUnknownTopic(t *testing.T) {
	for _, args := range [][]string{{"help", "bogus"}, {"help", "agent", "extra"}} {
		tc := newTestCLI(t, runtime.GOOS)
		if code := tc.main(args); code != 2 || !strings.Contains(tc.stderr.String(), "unknown help topic: "+args[1]) {
			t.Fatalf("%v: code %d, err %q", args, code, tc.stderr.String())
		}
		if !strings.Contains(tc.stdout.String(), "Usage: termote") {
			t.Fatalf("%v: no help printed", args)
		}
	}
}

// The guide must keep telling agents to leave the password to the user.
func TestAgentGuideKeepsPasswordRule(t *testing.T) {
	if !strings.Contains(agentGuide, "Do not run `termote show-password`") {
		t.Fatal("the agent guide lost the rule that agents do not run termote show-password")
	}
}

var (
	codeFenceRe  = regexp.MustCompile("(?s)```[a-z]*\n(.*?)```")
	inlineCodeRe = regexp.MustCompile("`([^`\n]+)`")
	termoteCmdRe = regexp.MustCompile(`(?:^|[\s!;(])termote\s+([a-z][a-z-]*)([^&|#]*)`)
	flagRe       = regexp.MustCompile(`--[a-z][a-z-]*`)
	helpCmdRe    = regexp.MustCompile(`^  ([a-z][a-z-]*)(?: / ([a-z][a-z-]*))?`)
)

// guideInvocations returns every "termote <cmd> [args]" written in code in
// the guide, as the command and the flags on it.
func guideInvocations(guide string) map[string][]string {
	var snippets []string
	for _, m := range codeFenceRe.FindAllStringSubmatch(guide, -1) {
		snippets = append(snippets, strings.Split(m[1], "\n")...)
	}
	rest := codeFenceRe.ReplaceAllString(guide, "")
	for _, m := range inlineCodeRe.FindAllStringSubmatch(rest, -1) {
		snippets = append(snippets, m[1])
	}
	found := map[string][]string{}
	for _, s := range snippets {
		for _, m := range termoteCmdRe.FindAllStringSubmatch(s, -1) {
			found[m[1]] = append(found[m[1]], flagRe.FindAllString(m[2], -1)...)
		}
	}
	return found
}

// helpCommands returns the commands the Commands: section of help lists.
func helpCommands(help string) map[string]bool {
	cmds := map[string]bool{}
	_, section, _ := strings.Cut(help, "Commands:\n")
	section, _, _ = strings.Cut(section, "\n\n")
	for _, line := range strings.Split(section, "\n") {
		if m := helpCmdRe.FindStringSubmatch(line); m != nil {
			cmds[m[1]] = true
			if m[2] != "" {
				cmds[m[2]] = true
			}
		}
	}
	return cmds
}

// Every command and flag the guide tells an agent to run must exist.
func TestAgentGuideCommandsAndFlagsExist(t *testing.T) {
	tc := newTestCLI(t, runtime.GOOS)
	tc.printHelp()
	help := tc.stdout.String()
	cmds := helpCommands(help)
	if !cmds["start"] || !cmds["unlink"] || !cmds["help"] {
		t.Fatalf("could not read the Commands section of help: %v", cmds)
	}
	found := guideInvocations(agentGuide)
	if len(found) < 5 {
		t.Fatalf("found too few termote commands in the guide: %v", found)
	}
	for cmd, flags := range found {
		if !cmds[cmd] {
			t.Errorf("the guide runs termote %s, which help does not list", cmd)
		}
		for _, f := range flags {
			if !strings.Contains(help, f) {
				t.Errorf("the guide passes %s to termote %s, which help does not list", f, cmd)
			}
		}
	}
}

func TestGuideInvocationsParsing(t *testing.T) {
	guide := "Run `termote start --lan=false`, not `tailscale set --operator`.\n" +
		"```bash\nbrew upgrade termote && termote restart\ntermote bogus --nope # --ignored\n```\n"
	got := guideInvocations(guide)
	if len(got) != 3 || len(got["start"]) != 1 || got["start"][0] != "--lan" ||
		len(got["bogus"]) != 1 || got["bogus"][0] != "--nope" {
		t.Fatalf("got %v", got)
	}
	if _, ok := got["restart"]; !ok {
		t.Fatalf("restart after && not found: %v", got)
	}
}
