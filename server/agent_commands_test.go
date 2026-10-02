package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseCommandMeta(t *testing.T) {
	cases := []struct {
		in   string
		want commandMeta
	}{
		{"---\ndescription: Plain value\n---\nbody", commandMeta{description: "Plain value"}},
		{"---\ndescription: \"Quoted: \\\"x\\\"\"\n---\n", commandMeta{description: `Quoted: "x"`}},
		{"---\ndescription: 'it''s'\n---\n", commandMeta{description: "it's"}},
		{"---\ndescription: value # comment\n---\n", commandMeta{description: "value"}},
		{"---\nname: ak:cook\ndescription: >-\n  Folded\n  over lines\nother: x\n---\n", commandMeta{name: "ak:cook", description: "Folded over lines"}},
		{"---\ndescription: |\n  Literal\n\n  block\n---\n", commandMeta{description: "Literal block"}},
		{"---\r\ndescription: CRLF\r\n---\r\n", commandMeta{description: "CRLF"}},
		{"\uFEFF---\ndescription: BOM\n---\n", commandMeta{description: "BOM"}},
		{"---\nuser-invocable: false\n# a comment\nmetadata:\n  author: x\n---\n\n# Title line\n", commandMeta{description: "Title line", hidden: true}},
		{"---\nargument-hint: x\n---\n", commandMeta{}},
		{"\n\n## Review the diff\nmore", commandMeta{description: "Review the diff"}},
		{"---\ndescription: never closed\n", commandMeta{}},
		{"", commandMeta{}},
		{"plain   spaced\ttext", commandMeta{description: "plain spaced text"}},
	}
	for _, c := range cases {
		if got := parseCommandMeta([]byte(c.in)); got != c.want {
			t.Errorf("parseCommandMeta(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
	long := parseCommandMeta([]byte(strings.Repeat("é", 300)))
	if n := len([]rune(long.description)); n != commandDescMax || !strings.HasSuffix(long.description, "…") {
		t.Errorf("long description = %d runes", n)
	}
	// Invalid UTF-8 is replaced, not passed through.
	if got := parseCommandMeta([]byte("bad \xff byte")); got.description != "bad \uFFFD byte" {
		t.Errorf("invalid UTF-8 = %q", got.description)
	}
}

func TestValidCommandName(t *testing.T) {
	for _, ok := range []string{"review", "a:b", "ak:cook", "x_y-z.1", "tên"} {
		if !validCommandName(ok) {
			t.Errorf("validCommandName(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", ":a", "-x", "a b", "a/b", "a;b", "a\nb", strings.Repeat("a", commandNameMax+1)} {
		if validCommandName(bad) {
			t.Errorf("validCommandName(%q) = true", bad)
		}
	}
}

func TestListAgentCommands(t *testing.T) {
	root, claude := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/deploy.md"), "---\ndescription: Deploy it\n---\nSECRET BODY")
	writeFile(t, filepath.Join(root, ".claude/commands/frontend/component.md"), "Make a component")
	writeFile(t, filepath.Join(root, ".claude/commands/a/b/c/d.md"), "deepest kept")
	writeFile(t, filepath.Join(root, ".claude/commands/a/b/c/d/e.md"), "too deep")
	writeFile(t, filepath.Join(root, ".claude/commands/.hidden/x.md"), "hidden dir")
	writeFile(t, filepath.Join(root, ".claude/commands/notes.txt"), "not markdown")
	writeFile(t, filepath.Join(root, ".claude/commands/bad name.md"), "invalid name")
	writeFile(t, filepath.Join(root, ".claude/skills/deploy-staging/SKILL.md"), "---\nname: ship\ndescription: Ship to staging\n---\n")
	writeFile(t, filepath.Join(root, ".claude/skills/internal/SKILL.md"), "---\nuser-invocable: false\ndescription: x\n---\n")
	writeFile(t, filepath.Join(root, ".claude/skills/no-skill-file/README.md"), "x")
	writeFile(t, filepath.Join(root, ".claude/skills/loose.md"), "a file, not a skill dir")
	writeFile(t, filepath.Join(root, ".claude/skills/.hidden/SKILL.md"), "hidden skill dir")
	writeFile(t, filepath.Join(claude, "commands/deploy.md"), "user deploy, shadowed by the project's")
	writeFile(t, filepath.Join(claude, "commands/mine.md"), "---\ndescription: Mine\n---\n")
	writeFile(t, filepath.Join(claude, "skills/helper/SKILL.md"), "---\ndescription: Helps\n---\n")

	got := listAgentCommands(root, claude, "", nil).Commands
	want := []agentCommand{
		{"a:b:c:d", "deepest kept", "project", "command"},
		{"deploy", "Deploy it", "project", "command"},
		{"frontend:component", "Make a component", "project", "command"},
		{"ship", "Ship to staging", "project", "skill"},
		{"mine", "Mine", "user", "command"},
		{"helper", "Helps", "user", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
	for _, c := range got {
		if strings.Contains(c.Description, "SECRET") {
			t.Errorf("a command body leaked: %+v", c)
		}
	}
	if got := listAgentCommands("", "", "", nil).Commands; len(got) != 0 {
		t.Errorf("no dirs = %v", got)
	}
	if got := listAgentCommands("relative", "also/relative", "", nil).Commands; len(got) != 0 {
		t.Errorf("relative dirs = %v", got)
	}
}

func TestListAgentCommandsStaysInRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root, outside := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.md"), "---\ndescription: outside\n---\n")
	writeFile(t, filepath.Join(outside, "skill/SKILL.md"), "---\ndescription: outside skill\n---\n")
	writeFile(t, filepath.Join(root, "shared/inside/SKILL.md"), "---\ndescription: inside skill\n---\n")
	os.MkdirAll(filepath.Join(root, ".claude/commands"), 0o755)
	os.MkdirAll(filepath.Join(root, ".claude/skills"), 0o755)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, ".claude/commands/leak.md")))
	must(os.Symlink(outside, filepath.Join(root, ".claude/commands/dir")))
	must(os.Symlink(filepath.Join(outside, "skill"), filepath.Join(root, ".claude/skills/out")))
	// A relative link that stays in the root is followed; os.Root refuses
	// absolute ones.
	must(os.Symlink("../../shared/inside", filepath.Join(root, ".claude/skills/in")))

	// A file symlink is never read, even inside the root: it could name a
	// file that is not a command.
	writeFile(t, filepath.Join(root, ".env"), "API_KEY=secret-value")
	must(os.Symlink("../../.env", filepath.Join(root, ".claude/commands/env.md")))
	writeFile(t, filepath.Join(root, "shared/linked/SKILL.md"), "---\ndescription: x\n---\n")
	os.MkdirAll(filepath.Join(root, ".claude/skills/linkfile"), 0o755)
	must(os.Symlink("../../../shared/linked/SKILL.md", filepath.Join(root, ".claude/skills/linkfile/SKILL.md")))

	got := listAgentCommands(root, "", "", nil).Commands
	want := []agentCommand{{"in", "inside skill", "project", "skill"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands = %v, want %v", got, want)
	}
}

func TestListAgentCommandsLimits(t *testing.T) {
	claude := t.TempDir()
	for i := 0; i < commandsMaxPerSource+5; i++ {
		writeFile(t, filepath.Join(claude, "commands", fmt.Sprintf("c%03d.md", i)), "x")
	}
	// Only the head of a file is read: a description past it is not found.
	writeFile(t, filepath.Join(claude, "skills/big/SKILL.md"), "---\n"+strings.Repeat("k: v\n", commandHeadSize/5)+"description: late\n---\n")
	got := listAgentCommands("", claude, "", nil).Commands
	if len(got) != commandsMaxPerSource+1 {
		t.Fatalf("got %d commands, want %d", len(got), commandsMaxPerSource+1)
	}
	if last := got[len(got)-1]; last.Name != "big" || last.Description != "" {
		t.Errorf("big skill = %+v", last)
	}
}

func commandsServer(t *testing.T, s AgentSession, found bool, dir string, files bool) *http.ServeMux {
	t.Helper()
	m := &commandsFakeMux{filesFakeMux: filesFakeMux{dir: dir, files: files}, s: s, found: found}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, m, newStreamTokenStore())
	f := registerFilesRoutes(mux, m, parseAllowedHosts("", false), nil)
	agent.registerCommandsRoute(mux, f, parseAllowedHosts("", false))
	return mux
}

// commandsFakeMux has both a pane directory and an agent locator.
type commandsFakeMux struct {
	filesFakeMux
	s     AgentSession
	found bool
}

func (f *commandsFakeMux) Caps() Caps { return Caps{Files: f.files, AgentChat: true} }
func (f *commandsFakeMux) AgentSession(_ context.Context, _ string) (AgentSession, bool, error) {
	return f.s, f.found, nil
}

func getCommands(t *testing.T, h http.Handler, req *http.Request) (int, []agentCommand) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body commandsResponse
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body.Commands
}

func TestCommandsRoute(t *testing.T) {
	root, claude := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/proj.md"), "Project one")
	writeFile(t, filepath.Join(claude, "commands/usr.md"), "User one")
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: claude}
	path := "/api/mux/panes/1/agent/commands"

	mux := commandsServer(t, s, true, root, true)
	code, cmds := getCommands(t, mux, httptest.NewRequest(http.MethodGet, path, nil))
	if code != http.StatusOK || len(cmds) != 2 || cmds[0].Name != "proj" || cmds[1].Name != "usr" {
		t.Fatalf("GET = %d %v", code, cmds)
	}

	// Another site's page cannot read the list.
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if code, _ := getCommands(t, mux, req); code != http.StatusForbidden {
		t.Errorf("cross-site = %d", code)
	}
	req = httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Origin", "https://evil.example")
	if code, _ := getCommands(t, mux, req); code != http.StatusForbidden {
		t.Errorf("foreign origin = %d", code)
	}
	if code, _ := getCommands(t, mux, httptest.NewRequest(http.MethodPost, path, nil)); code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", code)
	}

	// No agent in the pane.
	if code, _ := getCommands(t, commandsServer(t, s, false, root, true), httptest.NewRequest(http.MethodGet, path, nil)); code != http.StatusNotFound {
		t.Errorf("no agent = %d", code)
	}
	// A backend without pane directories still lists the user's commands.
	code, cmds = getCommands(t, commandsServer(t, s, true, root, false), httptest.NewRequest(http.MethodGet, path, nil))
	if code != http.StatusOK || len(cmds) != 1 || cmds[0].Name != "usr" {
		t.Errorf("no files caps = %d %v", code, cmds)
	}
	// A pane directory that is gone: user commands only.
	code, cmds = getCommands(t, commandsServer(t, s, true, filepath.Join(root, "missing"), true), httptest.NewRequest(http.MethodGet, path, nil))
	if code != http.StatusOK || len(cmds) != 1 || cmds[0].Name != "usr" {
		t.Errorf("missing dir = %d %v", code, cmds)
	}
}

func TestCommandsRouteUnsupportedBackend(t *testing.T) {
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, &fakeMux{}, newStreamTokenStore())
	agent.registerCommandsRoute(mux, nil, parseAllowedHosts("", false))
	if code, _ := getCommands(t, mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil)); code != http.StatusNotFound {
		t.Errorf("no locator = %d", code)
	}
}

func TestCommandsRouteSkipsDeniedRoot(t *testing.T) {
	root, claude := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/proj.md"), "Project one")
	m := &commandsFakeMux{filesFakeMux: filesFakeMux{dir: root, files: true}, s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: claude}, found: true}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, m, newStreamTokenStore())
	f := registerFilesRoutes(mux, m, parseAllowedHosts("", false), []string{root})
	agent.registerCommandsRoute(mux, f, parseAllowedHosts("", false))
	code, cmds := getCommands(t, mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil))
	if code != http.StatusOK || len(cmds) != 0 {
		t.Errorf("denied root = %d %v", code, cmds)
	}
}

func TestListAgentCommandsSkip(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/ok.md"), "fine")
	writeFile(t, filepath.Join(root, ".claude/commands/id_rsa.md"), "refused")
	writeFile(t, filepath.Join(root, ".claude/skills/bad/SKILL.md"), "---\nname: 'bad name'\n---\n")
	var asked []string
	skip := func(dir, rel string) bool {
		asked = append(asked, rel)
		return strings.Contains(rel, "id_rsa")
	}
	got := listAgentCommands(root, "", "", skip).Commands
	if len(got) != 1 || got[0].Name != "ok" {
		t.Fatalf("commands = %v", got)
	}
	if len(asked) != 3 || asked[0] != filepath.FromSlash(".claude/commands/id_rsa.md") {
		t.Errorf("skip asked for %v", asked)
	}
	// The route refuses what the files routes refuse: denied dirs and
	// sensitive names.
	a := &agentAPI{files: &filesAPI{deny: []string{filepath.Join(root, "private")}}}
	if !a.commandSkip(root, filepath.Join("private", "x.md")) {
		t.Error("commandSkip let a denied path through")
	}
	if !a.commandSkip(root, "id_rsa") {
		t.Error("commandSkip let a sensitive name through")
	}
	if a.commandSkip(root, filepath.Join(".claude", "commands", "ok.md")) {
		t.Error("commandSkip refused an ordinary command")
	}
	if (&agentAPI{}).commandSkip(root, filepath.Join("private", "x.md")) {
		t.Error("no files API: only names are checked")
	}
}

func TestListAgentCommandsVisitBudget(t *testing.T) {
	claude := t.TempDir()
	// The first dir uses the whole budget: the one after it is not read.
	for i := 0; i < commandsMaxVisited-1; i++ {
		writeFile(t, filepath.Join(claude, "commands", fmt.Sprintf("n%04d.txt", i)), "")
	}
	writeFile(t, filepath.Join(claude, "commands/zz/late.md"), "late")
	writeFile(t, filepath.Join(claude, "skills/s/SKILL.md"), "a skill")
	got := listAgentCommands("", claude, "", nil).Commands
	if len(got) != 1 || got[0].Name != "s" {
		t.Fatalf("commands = %v", got)
	}
}

func TestListAgentCommandsOddEntries(t *testing.T) {
	claude := t.TempDir()
	// SKILL.md that is a directory, not a file.
	if err := os.MkdirAll(filepath.Join(claude, "skills/odd/SKILL.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	// An invalid escape in a double-quoted value keeps the text inside the quotes.
	writeFile(t, filepath.Join(claude, "skills/esc/SKILL.md"), "---\ndescription: \"a \\q b\"\n---\n")
	for i := 0; i < commandsMaxPerSource+2; i++ {
		writeFile(t, filepath.Join(claude, "skills", fmt.Sprintf("s%03d/SKILL.md", i)), "x")
	}
	got := listAgentCommands("", claude, "", nil).Commands
	if len(got) != commandsMaxPerSource || got[0].Name != "esc" || got[0].Description != `a \q b` {
		t.Fatalf("got %d skills, first %+v", len(got), got[0])
	}
	if got := listAgentCommands(filepath.Join(claude, "missing"), "", "", nil).Commands; len(got) != 0 {
		t.Errorf("missing root = %v", got)
	}
}
