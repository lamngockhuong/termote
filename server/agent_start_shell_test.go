package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

// shellStartFake is a backend without agent.start that runs tasks (tmux,
// Zellij, herdr-core): its pane "%0" has a shell, and the agent the process
// walk would find is what the test sets.
type shellStartFake struct {
	*taskFakeMux
	session AgentSession
	found   bool
	nowErr  error
	// hangType: TypeLine waits out its context, then fails as a killed
	// tmux does (an exit error, not the context's).
	hangType bool
}

func (f *shellStartFake) TypeLine(ctx context.Context, target, line string) error {
	if f.hangType {
		<-ctx.Done()
		return errors.New("signal: killed")
	}
	return f.taskFakeMux.TypeLine(ctx, target, line)
}

func (f *shellStartFake) Caps() Caps {
	return Caps{Files: true, AgentStart: true, AgentStartCodex: true}
}

func (f *shellStartFake) AgentSessionNow(context.Context, string) (AgentSession, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.session, f.found, f.nowErr
}

func (f *shellStartFake) setAgent(s AgentSession, found bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.session, f.found = s, found
}

func (f *shellStartFake) Capture(context.Context, string) (string, error)         { return "", nil }
func (f *shellStartFake) Paste(context.Context, string, string) error             { return nil }
func (f *shellStartFake) SendKeySequence(context.Context, string, []string) error { return nil }

const shellStartPane = "%0"

// The id escaped, as the PWA sends it.
var shellStartPath = "/api/mux/panes/" + url.PathEscape(shellStartPane) + "/agent/start"

func shellStartAPI(t *testing.T) (http.Handler, *agentAPI, *shellStartFake) {
	t.Helper()
	shortStart(t)
	f := &shellStartFake{taskFakeMux: newTaskFake(t, t.TempDir())}
	setShellStartProc(t, "")
	mux := http.NewServeMux()
	a := registerMuxRoutes(mux, f, newStreamTokenStore(), nil, nil)
	return mux, a, f
}

// setShellStartProc makes the process walk find agent ("" none).
func setShellStartProc(t *testing.T, agent string) {
	t.Helper()
	prev := shellStartProc
	shellStartProc = func(int) (string, bool) { return agent, agent != "" }
	t.Cleanup(func() { shellStartProc = prev })
}

func postShellStart(t *testing.T, h http.Handler, kind string) (int, string) {
	t.Helper()
	rec := serve(h, apiRequest(http.MethodPost, shellStartPath, `{"kind":"`+kind+`"}`))
	code, _ := decodeBody(t, rec)["code"].(string)
	return rec.Code, code
}

func getShellStart(t *testing.T, h http.Handler) (int, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest(http.MethodGet, shellStartPath, ""))
	return rec.Code, decodeBody(t, rec)
}

// The line is typed after C-c, with the server's own arguments quoted for
// the shell; the client's extra fields are not read.
func TestShellAgentStartTypesLine(t *testing.T) {
	for _, c := range []struct {
		kind, shell, want string
	}{
		{"claude", "bash", "claude"},
		{"codex", "zsh", "codex '--no-daemon'"},
		{"codex", "pwsh", "codex '--no-daemon'"},
		{"opencode", "fish", "opencode '--session' 'ses_"},
	} {
		t.Run(c.kind+" "+c.shell, func(t *testing.T) {
			h, _, f := shellStartAPI(t)
			f.shell = c.shell
			rec := serve(h, apiRequest(http.MethodPost, shellStartPath, `{"kind":"`+c.kind+`","args":["--evil"],"name":"x"}`))
			if rec.Code != http.StatusOK {
				t.Fatalf("POST = %d %v", rec.Code, decodeBody(t, rec))
			}
			typed := f.typedLines()
			if len(typed) != 1 || !strings.HasPrefix(typed[0], shellStartPane+" "+c.want) || strings.Contains(typed[0], "evil") {
				t.Fatalf("typed %q, want %q", typed, c.want)
			}
			if !slices.Equal(f.interrupts, []string{shellStartPane}) {
				t.Errorf("interrupts = %q", f.interrupts)
			}
		})
	}
}

// A busy pane is refused with nothing sent, not even C-c.
func TestShellAgentStartBusyPane(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.busy[shellStartPane] = true
	if status, code := postShellStart(t, h, "claude"); status != http.StatusConflict || code != "pane_busy" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if len(f.interrupts) != 0 || len(f.typedLines()) != 0 {
		t.Errorf("sent C-c %q, typed %q", f.interrupts, f.typedLines())
	}
	if status, _ := getShellStart(t, h); status != http.StatusNotFound {
		t.Errorf("GET after a refused start = %d, want no_start", status)
	}
}

// After the C-c the shell is checked again: a pane busy then is refused
// with nothing typed.
func TestShellAgentStartBusyAfterClear(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.interrupt = func() error { f.busy[shellStartPane] = true; return nil }
	if status, code := postShellStart(t, h, "claude"); status != http.StatusConflict || code != "pane_busy" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if len(f.interrupts) != 1 || len(f.typedLines()) != 0 {
		t.Errorf("interrupts %q, typed %q", f.interrupts, f.typedLines())
	}
}

// A shell whose quoting is not known gets nothing typed.
func TestShellAgentStartUnsupportedShell(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.shell = "cmd.exe"
	if status, code := postShellStart(t, h, "claude"); status != http.StatusConflict || code != "unsupported_shell" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if len(f.typedLines()) != 0 || len(f.interrupts) != 0 {
		t.Errorf("typed %q, interrupts %q", f.typedLines(), f.interrupts)
	}
}

// A typing cut short by its timeout may have typed part of the line: the
// start is followed as if typed.
func TestShellAgentStartTypeTimeout(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.hangType = true
	if status, code := postShellStart(t, h, "claude"); status != http.StatusGatewayTimeout || code != "start_unknown" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if status, body := getShellStart(t, h); status != http.StatusOK || body["state"] != "starting" {
		t.Errorf("GET = %d %v, want starting", status, body)
	}
}

// The agent's process in the foreground is enough: Codex has no session to
// read before its first message.
func TestShellAgentStartStateProcess(t *testing.T) {
	for _, c := range []struct{ proc, state string }{
		{"codex", "ready"},
		{"claude", "exited"},
	} {
		t.Run(c.proc, func(t *testing.T) {
			h, _, _ := shellStartAPI(t)
			if status, code := postShellStart(t, h, "codex"); status != http.StatusOK {
				t.Fatalf("POST = %d %q", status, code)
			}
			setShellStartProc(t, c.proc)
			if _, body := getShellStart(t, h); body["state"] != c.state {
				t.Errorf("GET = %v, want %s", body, c.state)
			}
		})
	}
}

func TestShellAgentStartUnknownPane(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.gone[shellStartPane] = true
	if status, code := postShellStart(t, h, "claude"); status != http.StatusNotFound || code != "not_found" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if len(f.interrupts) != 0 {
		t.Errorf("interrupts %q", f.interrupts)
	}
}

// A failed typing answers start_failed and leaves no start to follow.
func TestShellAgentStartTypeFails(t *testing.T) {
	h, _, f := shellStartAPI(t)
	f.typeErr = errors.New("send-keys failed")
	if status, code := postShellStart(t, h, "claude"); status != http.StatusInternalServerError || code != "start_failed" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if status, _ := getShellStart(t, h); status != http.StatusNotFound {
		t.Errorf("GET = %d, want no_start", status)
	}
}

func TestShellAgentStartState(t *testing.T) {
	for _, c := range []struct {
		name    string
		session AgentSession
		found   bool
		settled bool
		busy    bool
		state   string
	}{
		{"ready", AgentSession{Agent: "claude", Status: "idle"}, true, false, true, "ready"},
		{"blocked", AgentSession{Agent: "claude", Status: "blocked"}, true, false, true, "blocked"},
		{"another agent", AgentSession{Agent: "codex", Status: "idle"}, true, false, true, "exited"},
		{"not settled", AgentSession{}, false, false, false, "starting"},
		{"still running", AgentSession{}, false, true, true, "starting"},
		{"shell back", AgentSession{}, false, true, false, "exited"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h, a, f := shellStartAPI(t)
			if status, code := postShellStart(t, h, "claude"); status != http.StatusOK {
				t.Fatalf("POST = %d %q", status, code)
			}
			if c.settled {
				a.starts.mu.Lock()
				a.starts.panes[shellStartPane].started = time.Now().Add(-agentStartSettle)
				a.starts.mu.Unlock()
			}
			f.mu.Lock()
			f.busy[shellStartPane] = c.busy
			f.mu.Unlock()
			f.setAgent(c.session, c.found)
			status, body := getShellStart(t, h)
			if status != http.StatusOK || body["state"] != c.state || body["kind"] != "claude" {
				t.Fatalf("GET = %d %v, want %s", status, body, c.state)
			}
			if c.state == "starting" {
				// A second start in the pane is refused while this one is followed.
				if status, code := postShellStart(t, h, "claude"); status != http.StatusConflict || code != "starting" {
					t.Errorf("second POST = %d %q", status, code)
				}
				return
			}
			// A final state is kept: the pane changing does not change it.
			f.setAgent(AgentSession{}, false)
			if _, body := getShellStart(t, h); body["state"] != c.state {
				t.Errorf("second GET = %v", body)
			}
		})
	}
}

// A gone pane is exited, never an error.
func TestShellAgentStartStatePaneGone(t *testing.T) {
	h, _, f := shellStartAPI(t)
	if status, code := postShellStart(t, h, "claude"); status != http.StatusOK {
		t.Fatalf("POST = %d %q", status, code)
	}
	f.mu.Lock()
	f.nowErr = errUnknownPane
	f.mu.Unlock()
	if _, body := getShellStart(t, h); body["state"] != "exited" {
		t.Errorf("GET = %v, want exited", body)
	}
}

// A start whose agent never showed past the deadline is timed out.
func TestShellAgentStartStateTimeout(t *testing.T) {
	h, a, _ := shellStartAPI(t)
	if status, code := postShellStart(t, h, "claude"); status != http.StatusOK {
		t.Fatalf("POST = %d %q", status, code)
	}
	a.starts.mu.Lock()
	a.starts.panes[shellStartPane].started = time.Now().Add(-agentStartTimeout - agentStartGrace - time.Second)
	a.starts.mu.Unlock()
	// The pane still runs the typed command (busy), with no agent seen.
	if _, body := getShellStart(t, h); body["state"] != "timeout" {
		t.Errorf("GET = %v, want timeout", body)
	}
}

func TestShellAgentStartCaps(t *testing.T) {
	start, codex := canShellStart()
	if start != agentProcSupported || codex != (agentProcSupported && codexProcSupported) {
		t.Errorf("canShellStart() = %v %v", start, codex)
	}
	if c := (tmuxMux{}).Caps(); c.AgentStart != (start && !tmuxIsPsmux) {
		t.Errorf("tmux AgentStart = %v", c.AgentStart)
	}
	if _, ok := shellStarterOf(&fakeMux{}); ok {
		t.Error("shellStarterOf(fakeMux) without taskMux")
	}
	if _, ok := shellStarterOf(&shellStartFake{taskFakeMux: newTaskFake(t, t.TempDir())}); !ok {
		t.Error("shellStarterOf(taskMux + agentWriter) = false")
	}
}
