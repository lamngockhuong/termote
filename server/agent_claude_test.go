package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const claudeFixture = "testdata/claude/transcript-2.1.285.jsonl"

func parseFixture(t *testing.T) ([]TranscriptEntry, int64, []byte) {
	t.Helper()
	b, err := os.ReadFile(claudeFixture)
	if err != nil {
		t.Fatal(err)
	}
	entries, end := claudeJournal{}.Parse(bytes.NewReader(b), 0)
	return foldToolResults(entries), end, b
}

func TestClaudeParseFixture(t *testing.T) {
	entries, end, raw := parseFixture(t)
	// The last line has no '\n' yet: it is not consumed.
	if want := int64(bytes.LastIndexByte(raw, '\n') + 1); end != want {
		t.Errorf("end = %d, want %d (after the last complete line)", end, want)
	}
	type want struct {
		role  string
		parts string // kind[:text] per part, joined by '|'
	}
	describe := func(e TranscriptEntry) want {
		var ps []string
		for _, p := range e.Parts {
			s := p.Kind
			switch {
			case p.Kind == "tool":
				s += ":" + p.Tool + "(" + p.Input + ")=" + p.Result
				if p.IsError {
					s += "!"
				}
				if p.Orphan {
					s += "~orphan"
				}
			case p.Text != "":
				s += ":" + p.Text
			}
			ps = append(ps, s)
		}
		return want{e.Role, strings.Join(ps, "|")}
	}
	wants := []want{
		{"user", "text:Fix the build please"},
		{"user", "text:/model opus"},
		{"note", "text:Set model to opus"},
		{"note", "text:Agent finished"},
		{"user", "text:What is in this screenshot?|image"},
		{"assistant", "thinking:Let me look."},
		{"assistant", "text:Running the tests.|tool:Bash(npm test -- --run)=1 failed!"},
		{"user", "tool:result()=older call output~orphan"},
		{"summary", "text:This session is being continued. Summary: fixed build."},
		{"assistant", "tool:Grep(TODO)="},
		{"assistant", "text:Done."},
	}
	if len(entries) != len(wants) {
		for _, e := range entries {
			t.Logf("%+v", describe(e))
		}
		t.Fatalf("got %d entries, want %d", len(entries), len(wants))
	}
	for i, w := range wants {
		if got := describe(entries[i]); got != w {
			t.Errorf("entry %d = %+v, want %+v", i, got, w)
		}
	}
	if entries[0].ID != "00000000-0000-4000-8000-000000000001" || entries[0].TS != "2026-10-01T00:00:01Z" {
		t.Errorf("entry 0 id/ts = %q %q", entries[0].ID, entries[0].TS)
	}
	// The tool result folded onto its call keeps the call's id.
	if p := entries[6].Parts[1]; p.ToolID != "toolu_1" {
		t.Errorf("tool id = %q", p.ToolID)
	}
	if p := entries[7].Parts[0]; p.ToolID != "toolu_gone" {
		t.Errorf("orphan tool id = %q", p.ToolID)
	}
	// Nothing of an image's base64 reaches the reply.
	out, _ := json.Marshal(entries)
	if bytes.Contains(out, []byte("AAAA")) || bytes.Contains(out, []byte("BBBB")) {
		t.Error("image data leaked into the entries")
	}
}

func TestClaudeParseStartOffsetAndOffsets(t *testing.T) {
	_, _, raw := parseFixture(t)
	// Start at the line of entry "Running the tests.": its result folds in,
	// and offsets count from the given start.
	i := bytes.Index(raw, []byte(`{"type": "assistant", "uuid": "00000000-0000-4000-8000-000000000009"`))
	if i < 0 {
		t.Fatal("fixture line not found")
	}
	entries, _ := claudeJournal{}.Parse(bytes.NewReader(raw[i:]), int64(i))
	entries = foldToolResults(entries)
	if len(entries) == 0 || entries[0].off != int64(i) {
		t.Fatalf("first entry off = %v, want %d", entries, i)
	}
	if entries[0].Parts[1].Result != "1 failed" {
		t.Errorf("result not folded: %+v", entries[0].Parts[1])
	}
}

func TestClaudeParseResultInLaterRead(t *testing.T) {
	use := `{"type":"assistant","uuid":"a","message":{"content":[{"type":"tool_use","id":"t9","name":"Read","input":{"file_path":"/x/y.go"}}]}}` + "\n"
	res := `{"type":"user","uuid":"b","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"package main"}]}}` + "\n"
	both, _ := claudeJournal{}.Parse(strings.NewReader(use+res), 0)
	if f := foldToolResults(both); len(f) != 1 || f[0].Parts[0].Result != "package main" || f[0].Parts[0].Orphan {
		t.Fatalf("folded = %+v", f)
	}
	if both[1].Parts[0].Result != "package main" || !both[1].Parts[0].Orphan || both[0].Parts[0].Result != "" {
		t.Fatal("foldToolResults changed its input")
	}
	first, _ := claudeJournal{}.Parse(strings.NewReader(use), 0)
	if len(first) != 1 || first[0].Parts[0].Input != "/x/y.go" || first[0].Parts[0].Result != "" {
		t.Fatalf("first read = %+v", first)
	}
	// The next poll only has the result: an orphan the client attaches by id.
	second, _ := claudeJournal{}.Parse(strings.NewReader(res), int64(len(use)))
	if len(second) != 1 || !second[0].Parts[0].Orphan || second[0].Parts[0].ToolID != "t9" {
		t.Fatalf("second read = %+v", second)
	}
}

func TestClaudeParseClipsLongLineWithoutHoldingIt(t *testing.T) {
	head := `{"type":"user","uuid":"u1","message":{"content":"hi"}}` + "\n"
	long := `{"type":"user","uuid":"big","message":{"content":"` + strings.Repeat("x", 3<<20) + `"}}` + "\n"
	tail := `{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"after"}]}}` + "\n"
	data := []byte(head + long + tail)

	// Warm the reader pool so its buffer is not counted.
	claudeJournal{}.Parse(strings.NewReader(head), 0)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	entries, end := claudeJournal{}.Parse(bytes.NewReader(data), 0)
	runtime.ReadMemStats(&after)

	if end != int64(len(data)) {
		t.Errorf("end = %d, want %d", end, len(data))
	}
	if len(entries) != 3 || entries[1].Role != "note" || !entries[1].Parts[0].Clipped || entries[1].off != int64(len(head)) {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[2].Parts[0].Text != "after" {
		t.Errorf("line after the long one = %+v", entries[2])
	}
	if grew := after.TotalAlloc - before.TotalAlloc; grew > 4<<20 {
		t.Errorf("parsing a 3 MB line allocated %d bytes, want <= 4 MB", grew)
	}

	// A long line still being written is left for the next read.
	partial := []byte(head + long[:len(long)-1])
	if _, end := (claudeJournal{}).Parse(bytes.NewReader(partial), 0); end != int64(len(head)) {
		t.Errorf("end with partial long line = %d, want %d", end, len(head))
	}
}

func TestClaudeParseClampsText(t *testing.T) {
	text := strings.Repeat("é", claudeMaxText) // 2 bytes each
	line, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": "a", "message": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
	}})
	entries, _ := claudeJournal{}.Parse(bytes.NewReader(append(line, '\n')), 0)
	p := entries[0].Parts[0]
	if !p.Clipped || len(p.Text) > claudeMaxText || !strings.HasPrefix(text, p.Text) {
		t.Errorf("clipped=%v len=%d", p.Clipped, len(p.Text))
	}
}

func TestSummarizeToolInput(t *testing.T) {
	tests := []struct{ in, want string }{
		{`{"file_path":"/a/b.ts","old_string":"x"}`, "/a/b.ts"},
		{`{"path":"src","pattern":"TODO"}`, "TODO"},
		{`{"command":["bash","-lc","ls -la"]}`, "bash -lc ls -la"},
		{`{"zeta":"z","alpha":"first"}`, "first"},
		{`{"n":1}`, ""},
		{`"not an object"`, ""},
		{`{"command":"` + strings.Repeat("a", 300) + `"}`, strings.Repeat("a", 200) + "…"},
	}
	for _, tt := range tests {
		var in map[string]any
		json.Unmarshal([]byte(tt.in), &in)
		if got := summarizeToolInput(in); got != tt.want {
			t.Errorf("summarizeToolInput(%s) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestIsSessionID(t *testing.T) {
	for s, want := range map[string]bool{
		"797c4168-8e43-4af6-b6f6-4038c7adbf6f": true,
		"797C4168-8E43-4AF6-B6F6-4038C7ADBF6F": false,
		"../../etc/passwd":                     false,
		"797c4168-8e43-4af6-b6f6-4038c7adbf6":  false,
		"*":                                    false,
		"":                                     false,
	} {
		if got := isSessionID(s); got != want {
			t.Errorf("isSessionID(%q) = %v", s, got)
		}
	}
}

const testSessionID = "11111111-2222-4333-8444-555555555555"

// writeTranscript creates <dir>/projects/<project>/<id>.jsonl.
func writeTranscript(t *testing.T, dir, id, content string) string {
	t.Helper()
	p := filepath.Join(dir, "projects", "-home-u-proj", id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestClaudeLocate(t *testing.T) {
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, "")
	got, err := claudeJournal{}.Locate(AgentSession{ID: testSessionID, ClaudeDir: dir})
	want, _ := filepath.EvalSymlinks(p)
	if err != nil || got != want {
		t.Fatalf("Locate = %q, %v; want %q", got, err, want)
	}
	for name, s := range map[string]AgentSession{
		"not a uuid":   {ID: "../x", ClaudeDir: dir},
		"glob pattern": {ID: "*", ClaudeDir: dir},
		"relative dir": {ID: testSessionID, ClaudeDir: "rel"},
		"no dir":       {ID: testSessionID},
		"missing":      {ID: "99999999-2222-4333-8444-555555555555", ClaudeDir: dir},
	} {
		if _, err := (claudeJournal{}).Locate(s); err != errNoTranscript {
			t.Errorf("%s: err = %v, want errNoTranscript", name, err)
		}
	}
}

func TestClaudeLocateRejectsSymlinkOutside(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	dir, outside := t.TempDir(), t.TempDir()
	secret := filepath.Join(outside, "secret.jsonl")
	os.WriteFile(secret, []byte("{}\n"), 0o600)
	proj := filepath.Join(dir, "projects", "p")
	os.MkdirAll(proj, 0o755)
	if err := os.Symlink(secret, filepath.Join(proj, testSessionID+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if _, err := (claudeJournal{}).Locate(AgentSession{ID: testSessionID, ClaudeDir: dir}); err != errNoTranscript {
		t.Errorf("symlink outside claudeDir: err = %v, want errNoTranscript", err)
	}
	// A symlinked project dir inside claudeDir is fine.
	inside := filepath.Join(dir, "real")
	os.MkdirAll(inside, 0o755)
	os.WriteFile(filepath.Join(inside, testSessionID+".jsonl"), nil, 0o600)
	os.Remove(filepath.Join(proj, testSessionID+".jsonl"))
	os.Remove(proj)
	os.Symlink(inside, proj)
	if _, err := (claudeJournal{}).Locate(AgentSession{ID: testSessionID, ClaudeDir: dir}); err != nil {
		t.Errorf("symlink inside claudeDir: %v", err)
	}
}

func TestPathWithin(t *testing.T) {
	sep := string(filepath.Separator)
	dir := sep + "a" + sep + "b"
	for p, want := range map[string]bool{
		dir + sep + "c":                     true,
		dir:                                 false,
		sep + "a":                           false,
		sep + "a" + sep + "bc":              false,
		dir + sep + ".." + sep + "x":        false,
		dir + sep + "..x" + sep + "f.jsonl": true,
	} {
		if got := pathWithin(dir, filepath.Clean(p)); got != want {
			t.Errorf("pathWithin(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestReadClaudeSessionFile(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o755)
	write := func(pid int, body string) {
		os.WriteFile(filepath.Join(dir, "sessions", strconv.Itoa(pid)+".json"), []byte(body), 0o600)
	}
	write(10, `{"pid":10,"sessionId":"`+testSessionID+`","status":"busy","procStart":"123","pidDomain":"d"}`)
	write(11, `{"pid":12,"sessionId":"x"}`) // pid does not match the file name
	write(13, `not json`)
	write(14, `{"pid":14,"procStart":"1","procStartFt":"133000000000000000"}`)

	f, ok := readClaudeSessionFile(dir, 10)
	if !ok || f.SessionID != testSessionID || f.procStart() != "123" || claudeStatus(f.Status) != "working" {
		t.Errorf("pid 10 = %+v, %v", f, ok)
	}
	for _, pid := range []int{11, 13, 99} {
		if _, ok := readClaudeSessionFile(dir, pid); ok {
			t.Errorf("pid %d accepted", pid)
		}
	}
	if f, _ := readClaudeSessionFile(dir, 14); f.procStart() != "133000000000000000" {
		t.Errorf("procStartFt not preferred: %q", f.procStart())
	}
}

func TestClaudeStatus(t *testing.T) {
	for in, want := range map[string]string{"busy": "working", "idle": "idle", "waiting": "blocked", "": "unknown", "blocked": "unknown"} {
		if got := claudeStatus(in); got != want {
			t.Errorf("claudeStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClassifyClaudeUserText(t *testing.T) {
	if _, _, ok := classifyClaudeUserText("  \n "); ok {
		t.Error("blank text accepted")
	}
	if _, _, ok := classifyClaudeUserText("<command-name></command-name>"); ok {
		t.Error("empty command accepted")
	}
	// Claude Code 2.1.28x writes the message tag first.
	if role, s, ok := classifyClaudeUserText("<command-message>atk:review</command-message>\n<command-name>/atk:review</command-name>\n<command-args>12</command-args>"); !ok || role != "user" || s != "/atk:review 12" {
		t.Errorf("command-message first = %q %q %v", role, s, ok)
	}
	if _, s, _ := classifyClaudeUserText("\n\n<pasted_content id=\"5edd\">\nCount these\nrow 1\n</pasted_content id=\"5edd\">\n"); s != "Count these\nrow 1" {
		t.Errorf("pasted content = %q", s)
	}
	if role, s, ok := classifyClaudeUserText("see <system-reminder> in prose"); !ok || role != "user" || s == "" {
		t.Error("a tag inside prose is speech")
	}
}

func TestDefaultClaudeDir(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "/custom/claude")
	if got := defaultClaudeDir(); got != "/custom/claude" {
		t.Errorf("with CLAUDE_CONFIG_DIR = %q", got)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	home, _ := os.UserHomeDir()
	if got := defaultClaudeDir(); got != filepath.Join(home, ".claude") {
		t.Errorf("default = %q", got)
	}
}

func writeSessionFile(t *testing.T, dir string, pid int, procStart, domain, status string) {
	t.Helper()
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o755)
	body := fmt.Sprintf(`{"pid":%d,"sessionId":%q,"status":%q,"procStart":%q,"pidDomain":%q}`,
		pid, testSessionID, status, procStart, domain)
	if err := os.WriteFile(filepath.Join(dir, "sessions", strconv.Itoa(pid)+".json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadClaudeSessionFileRejectsNonRegular(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no FIFOs")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o755)
	big := `{"pid":5,"x":"` + strings.Repeat("a", 70*1024) + `"}`
	os.WriteFile(filepath.Join(dir, "sessions", "5.json"), []byte(big), 0o600)
	if _, ok := readClaudeSessionFile(dir, 5); ok {
		t.Error("oversized file accepted")
	}
	if err := os.Symlink("/dev/zero", filepath.Join(dir, "sessions", "6.json")); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() { _, ok := readClaudeSessionFile(dir, 6); done <- ok }()
	select {
	case ok := <-done:
		if ok {
			t.Error("device accepted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reading a link to /dev/zero did not return")
	}
}
