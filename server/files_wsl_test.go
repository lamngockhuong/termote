//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestWSLWindowsPath(t *testing.T) {
	w := wslWindows{distro: `\\wsl.localhost\Ubuntu`, mounts: "/mnt/"}
	for in, want := range map[string]string{
		"/":                    `\\wsl.localhost\Ubuntu\`,
		"/home/u/file.html":    `\\wsl.localhost\Ubuntu\home\u\file.html`,
		"/home/u/a,b c.html":   `\\wsl.localhost\Ubuntu\home\u\a,b c.html`,
		"/mnt/c":               `C:\`,
		"/mnt/c/":              `C:\`,
		"/mnt/c/Users/u/x.txt": `C:\Users\u\x.txt`,
		"/mnt/D/data":          `D:\data`,
		"/mnt/wsl/x":           `\\wsl.localhost\Ubuntu\mnt\wsl\x`,
		"/mnt/cc/x":            `\\wsl.localhost\Ubuntu\mnt\cc\x`,
		"/mnt/":                `\\wsl.localhost\Ubuntu\mnt\`,
		"relative":             "",
	} {
		if got := w.windowsPath(in); got != want {
			t.Errorf("windowsPath(%q) = %q, want %q", in, got, want)
		}
	}
	if got := (wslWindows{}).windowsPath("/home"); got != "" {
		t.Errorf("not WSL: %q", got)
	}
	// Without a drives' mount, every path is under the share
	if got := (wslWindows{distro: `\\wsl$\Debian`}).windowsPath("/mnt/c/x"); got != `\\wsl$\Debian\mnt\c\x` {
		t.Errorf("no mounts: %q", got)
	}
}

// stubWSL replaces wslpath and the interop check: answers maps the args of
// a call to its output; a call not in it fails.
func stubWSL(t *testing.T, answers map[string]string, interop bool) *[]string {
	t.Helper()
	var calls []string
	var mu sync.Mutex
	oldRun, oldFiles := wslRun, wslInteropFiles
	wslRun = func(_ context.Context, name string, args ...string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		key := strings.Join(append([]string{name}, args...), " ")
		calls = append(calls, key)
		if out, ok := answers[key]; ok {
			return out, nil
		}
		return "", errors.New("not stubbed")
	}
	f := filepath.Join(t.TempDir(), "WSLInterop")
	state := "disabled\n"
	if interop {
		state = "enabled\ninterpreter /init\n"
	}
	if err := os.WriteFile(f, []byte(state), 0o644); err != nil {
		t.Fatal(err)
	}
	wslInteropFiles = []string{filepath.Join(t.TempDir(), "missing"), f}
	t.Cleanup(func() { wslRun, wslInteropFiles = oldRun, oldFiles })
	return &calls
}

func TestDetectWSLWindows(t *testing.T) {
	mounts := plainDir(t) + "/"
	exe := filepath.Join(mounts, "c", "Windows", "explorer.exe")
	writeFile(t, exe, "MZ")
	answers := map[string]string{
		"wslpath -w /":    "\\\\wsl.localhost\\Ubuntu\\\n",
		"wslpath -u C:\\": mounts + "c/\n",
	}
	stubWSL(t, answers, true)
	got := detectWSLWindows(scopeWSL)
	want := wslWindows{distro: `\\wsl.localhost\Ubuntu`, mounts: mounts, explorer: mounts + "c/Windows/explorer.exe"}
	if got != want {
		t.Errorf("detect = %+v, want %+v", got, want)
	}
	ps := filepath.Join(mounts, "c", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	writeFile(t, ps, "MZ")
	want.powershell = ps
	if got := detectWSLWindows(scopeWSL); got != want {
		t.Errorf("detect with powershell = %+v, want %+v", got, want)
	}
	for _, scope := range []string{scopeHost, scopeContainer} {
		if got := detectWSLWindows(scope); got != (wslWindows{}) {
			t.Errorf("%s: %+v", scope, got)
		}
	}

	// Interop off: the paths, no explorer
	stubWSL(t, answers, false)
	if got := detectWSLWindows(scopeWSL); got.explorer != "" || got.distro == "" {
		t.Errorf("interop off = %+v", got)
	}
	// No explorer.exe where C: is mounted
	stubWSL(t, map[string]string{"wslpath -w /": `\\wsl$\Ubuntu`, "wslpath -u C:\\": "/nowhere/c/"}, true)
	if got := detectWSLWindows(scopeWSL); got != (wslWindows{distro: `\\wsl$\Ubuntu`, mounts: "/nowhere/"}) {
		t.Errorf("no explorer = %+v", got)
	}
	// C: not mounted: only the share
	stubWSL(t, map[string]string{"wslpath -w /": `\\wsl.localhost\Ubuntu`}, true)
	if got := detectWSLWindows(scopeWSL); got != (wslWindows{distro: `\\wsl.localhost\Ubuntu`}) {
		t.Errorf("no C: = %+v", got)
	}
	// wslpath missing, or answering something not a share
	for _, out := range []string{"", "/", "C:\\", "\\\\wsl.localhost\\U\nx"} {
		ans := map[string]string{}
		if out != "" {
			ans["wslpath -w /"] = out
		}
		stubWSL(t, ans, true)
		if got := detectWSLWindows(scopeWSL); got != (wslWindows{}) {
			t.Errorf("wslpath -w / = %q: %+v", out, got)
		}
	}
}

// openFixture is a download fixture whose server runs under WSL, with
// explorer.exe stubbed.
func newOpenFixture(t *testing.T) (*downloadFixture, *[]string) {
	t.Helper()
	fx := newDownloadFixture(t)
	fx.f.wsl = wslWindows{distro: `\\wsl.localhost\Ubuntu`, mounts: "/mnt/", explorer: "/mnt/c/Windows/explorer.exe"}
	calls := stubWSL(t, nil, true)
	old := wslRun
	wslRun = func(ctx context.Context, name string, args ...string) (string, error) {
		old(ctx, name, args...)
		// explorer.exe exits 1 when it opened the file
		return "", &exec.ExitError{}
	}
	t.Cleanup(func() { wslRun = old })
	return fx, calls
}

func (fx *downloadFixture) open(body any, a *authInfo) *http.Response {
	b, _ := json.Marshal(body)
	req := apiRequest("POST", "/api/mux/panes/0/files/open-windows?"+url.Values{"root": {fx.root}}.Encode(), string(b))
	// The fixture has no Host allowlist: writeGuard checks Origin, not this
	req.Header.Del("Origin")
	if a != nil {
		req = req.WithContext(withAuth(req.Context(), *a))
	}
	return serve(fx.mux, req).Result()
}

func errorCode(t *testing.T, res *http.Response) string {
	t.Helper()
	var body struct{ Code string }
	json.NewDecoder(res.Body).Decode(&body)
	return body.Code
}

func TestFilesOpenWindows(t *testing.T) {
	fx, calls := newOpenFixture(t)
	logs := captureLog(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "site/a b.md", "<h1>x</h1>")
	fx.write(t, ".env", "K=v")
	fx.write(t, "cfg/secret", "k")
	exe := "/mnt/c/Windows/explorer.exe "
	share := `\\wsl.localhost\Ubuntu` + strings.ReplaceAll(fx.root, "/", `\`)
	for _, c := range []struct {
		path   string
		reveal bool
		want   string
	}{
		{"site/a b.md", false, share + `\site\a b.md`},
		{"site", false, share + `\site`},
		{".", false, share},
		// An extension Windows is not known to show asks to run, a dotfile's included
		{".env", true, share + `\.env`},
	} {
		*calls = nil
		res := fx.open(openWindowsRequest{Path: c.path, Reveal: c.reveal, Run: c.reveal}, full)
		if res.StatusCode != 200 {
			t.Fatalf("%s = %d %s", c.path, res.StatusCode, errorCode(t, res))
		}
		if len(*calls) != 1 || (*calls)[0] != exe+c.want {
			t.Errorf("%s ran %q, want %q", c.path, *calls, exe+c.want)
		}
	}
	if n := strings.Count(logs.String(), "audit: open-windows"); n != 4 {
		t.Errorf("audit lines = %d:\n%s", n, logs)
	}

	cases := map[string]struct {
		path   string
		status int
		code   string
	}{
		"sensitive":   {".env", 403, "sensitive"},
		"denied":      {"cfg/secret", 403, "not_allowed"},
		"missing":     {"nope.html", 404, ""},
		"escape":      {"../x", 400, ""},
		"absolute":    {"/etc/passwd", 400, ""},
		"missing dir": {"nope/a.html", 404, ""},
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("site", filepath.Join(fx.root, "in")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("site/a b.md", filepath.Join(fx.root, "link.md")); err != nil {
			t.Fatal(err)
		}
		cases["symlinked parent"] = struct {
			path   string
			status int
			code   string
		}{"in/a b.md", 403, "symlink"}
		cases["symlinked file"] = struct {
			path   string
			status int
			code   string
		}{"link.md", 403, "symlink"}
	}
	for name, c := range cases {
		*calls = nil
		res := fx.open(openWindowsRequest{Path: c.path}, full)
		if res.StatusCode != c.status {
			t.Errorf("%s = %d, want %d", name, res.StatusCode, c.status)
		}
		if c.code != "" {
			if got := errorCode(t, res); got != c.code {
				t.Errorf("%s code = %q, want %q", name, got, c.code)
			}
		}
		if len(*calls) != 0 {
			t.Errorf("%s ran %q", name, *calls)
		}
	}

	// A view-only client, a GET and a request without root never run it
	*calls = nil
	if res := fx.open(openWindowsRequest{Path: "site"}, &authInfo{Kind: authDevice, Role: roleView}); res.StatusCode != 403 || errorCode(t, res) != "view_only" {
		t.Errorf("view-only = %d", res.StatusCode)
	}
	if rec := serve(fx.mux, apiRequest("GET", "/api/mux/panes/0/files/open-windows?root="+url.QueryEscape(fx.root), "")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", rec.Code)
	}
	if rec := serve(fx.mux, apiRequest("POST", "/api/mux/panes/0/files/open-windows", `{"path":"site"}`)); rec.Code != http.StatusBadRequest {
		t.Errorf("no root = %d", rec.Code)
	}
	if len(*calls) != 0 {
		t.Errorf("refused requests ran %q", *calls)
	}

	// Every slot taken: 429, nothing run
	for range cap(fx.f.rawSlots) {
		fx.f.rawSlots <- struct{}{}
	}
	if res := fx.open(openWindowsRequest{Path: "site"}, full); res.StatusCode != 429 || errorCode(t, res) != "busy" {
		t.Errorf("busy = %d", res.StatusCode)
	}
	for range cap(fx.f.rawSlots) {
		<-fx.f.rawSlots
	}

	// Another termote over the machine bridge: 501, nothing run
	b, _ := json.Marshal(openWindowsRequest{Path: "site"})
	req := apiRequest("POST", "/api/mux/panes/0/files/open-windows?"+url.Values{"root": {fx.root}}.Encode(), string(b))
	req.Header.Del("Origin")
	req = req.WithContext(context.WithValue(withAuth(req.Context(), *full), bridgeKey{}, true))
	if rec := serve(fx.mux, req); rec.Code != 501 {
		t.Errorf("bridge = %d %s", rec.Code, rec.Body)
	}

	// Not under WSL, or interop off: 501
	fx.f.wsl.explorer = ""
	if res := fx.open(openWindowsRequest{Path: "site"}, full); res.StatusCode != 501 || errorCode(t, res) != "unavailable" {
		t.Errorf("unavailable = %d", res.StatusCode)
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}

// A program that never started is an error; one that exits 1 is not.
func TestFilesOpenWindowsStartFails(t *testing.T) {
	fx, _ := newOpenFixture(t)
	fx.write(t, "a.md", "x")
	old := wslRun
	wslRun = func(context.Context, string, ...string) (string, error) { return "", exec.ErrNotFound }
	t.Cleanup(func() { wslRun = old })
	logs := captureLog(t)
	res := fx.open(openWindowsRequest{Path: "a.md"}, &authInfo{Kind: authSession, Role: roleFull})
	if res.StatusCode != 500 {
		t.Errorf("start failed = %d", res.StatusCode)
	}
	var body map[string]any
	json.NewDecoder(res.Body).Decode(&body)
	if strings.Contains(strings.ToLower(body["error"].(string)), "executable") {
		t.Errorf("OS text sent: %v", body)
	}
	if !strings.Contains(logs.String(), "open-windows") {
		t.Errorf("not logged:\n%s", logs)
	}
}

func TestFilesTreeWindowsRoot(t *testing.T) {
	fx := newDownloadFixture(t)
	get := func(a authInfo) map[string]any {
		req := apiRequest("GET", "/api/mux/panes/0/files/tree", "")
		req = req.WithContext(withAuth(req.Context(), a))
		rec := serve(fx.mux, req)
		if rec.Code != 200 {
			t.Fatalf("tree = %d %s", rec.Code, rec.Body)
		}
		return decodeBody(t, rec)
	}
	full := authInfo{Kind: authSession, Role: roleFull}
	if b := get(full); b["windowsRoot"] != nil || b["windowsOpen"] != nil {
		t.Errorf("not WSL: %v", b)
	}
	fx.f.wsl = wslWindows{distro: `\\wsl.localhost\Ubuntu`, mounts: "/mnt/", explorer: "/mnt/c/Windows/explorer.exe"}
	want := `\\wsl.localhost\Ubuntu` + strings.ReplaceAll(fx.root, "/", `\`)
	if b := get(full); b["windowsRoot"] != want || b["windowsOpen"] != true {
		t.Errorf("full = %v %v", b["windowsRoot"], b["windowsOpen"])
	}
	// A view-only client copies the path but never opens it
	var res treeResponse
	fx.f.wslTreeFields(&res, fx.root, true, false)
	if res.WindowsRoot != want || res.WindowsOpen {
		t.Errorf("view-only = %+v", res)
	}
	// Another termote over the machine bridge: neither
	req := apiRequest("GET", "/api/mux/panes/0/files/tree", "")
	req = req.WithContext(context.WithValue(withAuth(req.Context(), full), bridgeKey{}, true))
	if b := decodeBody(t, serve(fx.mux, req)); b["windowsRoot"] != nil || b["windowsOpen"] != nil {
		t.Errorf("bridge = %v %v", b["windowsRoot"], b["windowsOpen"])
	}
	fx.f.wsl.explorer = ""
	if b := get(full); b["windowsRoot"] != want || b["windowsOpen"] != nil {
		t.Errorf("interop off = %v %v", b["windowsRoot"], b["windowsOpen"])
	}
}

// A root gone between its resolve and the check is an error, nothing run.
func TestCheckOpenWindowsRootGone(t *testing.T) {
	fx, _ := newOpenFixture(t)
	gone := filepath.Join(fx.root, "gone")
	if _, _, err := fx.f.checkOpenWindows(filesRoot{Root: gone}, openWindowsRequest{Path: "a.md"}); err == nil {
		t.Error("no error for a missing root")
	}
}

// The real runner gives a program's output and runs it outside any share.
func TestWSLRunRunsProgram(t *testing.T) {
	out, err := wslRun(context.Background(), "go", "env", "GOOS")
	if err != nil || strings.TrimSpace(out) != runtime.GOOS {
		t.Errorf("go env GOOS = %q, %v", out, err)
	}
}

// The share Windows names is checked too: none, or one with a quote,
// opens nothing.
func TestCheckOpenWindowsOddShare(t *testing.T) {
	fx, _ := newOpenFixture(t)
	fx.write(t, "a.md", "x")
	for _, distro := range []string{"", `\\wsl.localhost\a"b`} {
		fx.f.wsl.distro = distro
		_, _, err := fx.f.checkOpenWindows(filesRoot{Root: fx.root}, openWindowsRequest{Path: "a.md"})
		if err != errWSLNotFile {
			t.Errorf("distro %q: %v", distro, err)
		}
	}
}

// On a Windows drive, Windows is asked whether the path, a folder on the way
// or an entry is a link, since drvfs may show an NT link as a plain file:
// refused when it says so, when it answers anything else or fails, and when
// there is no PowerShell to ask. The distribution's share is not asked.
func TestFilesOpenWindowsAsksWindowsForLinks(t *testing.T) {
	full := &authInfo{Kind: authSession, Role: roleFull}
	setup := func(t *testing.T, answer string, fail bool) (*downloadFixture, *[]string) {
		mounts := plainDir(t) + "/"
		root := filepath.Join(mounts, "c", "repo")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, nil)
		f.wsl = wslWindows{distro: `\\wsl.localhost\Ubuntu`, mounts: mounts, explorer: "/x/explorer.exe", powershell: "/x/powershell.exe"}
		fx := &downloadFixture{root: root, f: f, mux: mux}
		var calls []string
		old, oldPS := wslRun, wslRunPowershell
		wslRun = func(_ context.Context, name string, args ...string) (string, error) {
			calls = append(calls, name+" "+strings.Join(args, " "))
			return "", &exec.ExitError{}
		}
		wslRunPowershell = func(_ context.Context, exe, winPath string) (string, error) {
			if exe != "/x/powershell.exe" {
				t.Errorf("powershell %q", exe)
			}
			calls = append(calls, "ps "+winPath)
			if fail {
				return "", &exec.ExitError{}
			}
			return answer, nil
		}
		t.Cleanup(func() { wslRun, wslRunPowershell = old, oldPS })
		fx.write(t, "a.txt", "x")
		fx.write(t, "d/b.txt", "x")
		return fx, &calls
	}
	for _, path := range []string{"a.txt", "d"} {
		want := `C:\repo\` + path
		fx, calls := setup(t, "none\r\n", false)
		if res := fx.open(openWindowsRequest{Path: path}, full); res.StatusCode != 200 {
			t.Errorf("%s, no link = %d %s", path, res.StatusCode, errorCode(t, res))
		}
		if len(*calls) != 2 || (*calls)[0] != "ps "+want || (*calls)[1] != "/x/explorer.exe "+want {
			t.Errorf("%s calls %q", path, *calls)
		}
		for _, tc := range []struct {
			answer string
			fail   bool
		}{{"link\r\n", false}, {"", false}, {"none link", false}, {"", true}} {
			fx, calls := setup(t, tc.answer, tc.fail)
			if res := fx.open(openWindowsRequest{Path: path}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
				t.Errorf("%s, answer %q fail %v = %d", path, tc.answer, tc.fail, res.StatusCode)
			}
			if len(*calls) != 1 {
				t.Errorf("%s, answer %q: explorer ran: %q", path, tc.answer, *calls)
			}
		}
	}
	// No PowerShell to ask: refused, nothing run.
	fx, calls := setup(t, "none", false)
	fx.f.wsl.powershell = ""
	if res := fx.open(openWindowsRequest{Path: "a.txt"}, full); res.StatusCode != 403 || len(*calls) != 0 {
		t.Errorf("no powershell = %d, %q", res.StatusCode, *calls)
	}
	// The path reaches PowerShell as data: quotes and $ in a name included.
	fx, calls = setup(t, "none", false)
	fx.write(t, "it's $(x).txt", "x")
	if res := fx.open(openWindowsRequest{Path: "it's $(x).txt"}, full); res.StatusCode != 200 || (*calls)[0] != `ps C:\repo\it's $(x).txt` {
		t.Errorf("quoted name = %d, %q", res.StatusCode, *calls)
	}
}

// The distribution's share shows Linux's own view: PowerShell is not asked.
func TestFilesOpenWindowsShareNotAsked(t *testing.T) {
	fx, calls := newOpenFixture(t)
	fx.f.wsl.powershell = "/x/powershell.exe"
	old := wslRunPowershell
	wslRunPowershell = func(context.Context, string, string) (string, error) {
		*calls = append(*calls, "powershell")
		return "none", nil
	}
	t.Cleanup(func() { wslRunPowershell = old })
	fx.write(t, "a.txt", "x")
	if res := fx.open(openWindowsRequest{Path: "a.txt"}, &authInfo{Kind: authSession, Role: roleFull}); res.StatusCode != 200 {
		t.Errorf("share = %d", res.StatusCode)
	}
	for _, c := range *calls {
		if strings.Contains(c, "powershell") {
			t.Errorf("asked %q", c)
		}
	}
}

// The script is fixed: no double quote (WSL quotes argv for Windows), the
// path read only from the environment, and the item and the folders on the
// way looked at before the folder is listed.
func TestWindowsLinksScript(t *testing.T) {
	s := windowsLinksScript
	if strings.Contains(s, `"`) || !strings.Contains(s, "$env:TERMOTE_OPEN_PATH") {
		t.Errorf("script %q", s)
	}
	if i, j := strings.Index(s, "if (L $i)"), strings.Index(s, "Get-ChildItem"); i < 0 || j < 0 || i > j || strings.Index(s, "Split-Path") > j {
		t.Errorf("the folder is listed before its links are looked at: %q", s)
	}
}
