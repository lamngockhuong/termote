package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeOpencode is an OpenCode 2.3.0 service: the routes termote reads, with
// the shapes recorded from a real one (testdata/opencode), Basic auth and
// paging of messages by an opaque cursor.
type fakeOpencode struct {
	t        *testing.T
	srv      *httptest.Server
	password string
	mu       sync.Mutex
	version  string
	pid      int
	active   []string
	// messages per session, oldest first; a session absent answers 404.
	messages    map[string][]json.RawMessage
	permissions map[string]json.RawMessage
	forms       map[string]json.RawMessage
	// status forces an answer for every /api route but /api/info.
	status int
	// big: a page asking for at least this many messages is over
	// opencodeMessagesMax (0: never).
	big      int
	requests []string
	auths    []string
	// bodies of the write requests, in order.
	bodies []string
	// sessions answer GET /api/session/{id}; writeStatus forces an answer
	// for every write.
	sessions    map[string]json.RawMessage
	writeStatus int
}

const testOpencodePassword = "s3cret-opencode-password"

// newFakeOpencode starts the service and writes its service.json into a
// state dir the client reads.
func newFakeOpencode(t *testing.T) *fakeOpencode {
	t.Helper()
	f := &fakeOpencode{t: t, password: testOpencodePassword, version: "2.3.0", pid: 4242,
		messages: map[string][]json.RawMessage{}, permissions: map[string]json.RawMessage{},
		forms: map[string]json.RawMessage{}, sessions: map[string]json.RawMessage{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	state := t.TempDir()
	stubOpencodeStateDir(t, state)
	f.writeServiceFile(state, map[string]any{"id": "x", "version": "2.3.0", "url": f.srv.URL,
		"pid": f.pid, "password": f.password})
	return f
}

// stubOpencodeStateDir points the client at dir and drops every cache.
func stubOpencodeStateDir(t *testing.T, dir string) {
	t.Helper()
	prev := opencodeStateDir
	opencodeStateDir = func() string { return dir }
	resetOpencodeCaches()
	t.Cleanup(func() {
		opencodeStateDir = prev
		resetOpencodeCaches()
	})
}

func resetOpencodeCaches() {
	opencodeForget()
	opencodeDown.forgetPrefix("")
	opencodeActive.forgetPrefix("")
	opencodeBlocked.forgetPrefix("")
	opencodeReads.forgetPrefix("")
}

func (f *fakeOpencode) writeServiceFile(state string, v any) {
	f.t.Helper()
	dir := filepath.Join(state, "opencode")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	data, _ := json.Marshal(v)
	if err := os.WriteFile(filepath.Join(dir, "service.json"), data, 0o600); err != nil {
		f.t.Fatal(err)
	}
	resetOpencodeCaches()
}

func (f *fakeOpencode) set(fn func()) {
	f.mu.Lock()
	fn()
	f.mu.Unlock()
	opencodeActive.forgetPrefix("")
	opencodeBlocked.forgetPrefix("")
	opencodeReads.forgetPrefix("")
}

func (f *fakeOpencode) reqs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func (f *fakeOpencode) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
	f.auths = append(f.auths, r.Header.Get("Authorization"))
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode:"+f.password))
	if r.Header.Get("Authorization") != want {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"_tag":"UnauthorizedError","message":"Authentication required"}`))
		return
	}
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	notFound := func() {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"_tag":"SessionNotFoundError","message":"Session not found: secret words"}`))
	}
	path := r.URL.Path
	if path == "/api/info" {
		reply(map[string]any{"version": f.version, "pid": f.pid, "hostname": "host", "urls": []string{f.srv.URL}})
		return
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		w.Write([]byte(`{"_tag":"InternalError","message":"internal words /home/user"}`))
		return
	}
	if path == "/api/session/active" {
		data := map[string]any{}
		for _, id := range f.active {
			data[id] = map[string]string{"type": "running"}
		}
		reply(map[string]any{"data": data})
		return
	}
	rest, ok := strings.CutPrefix(path, "/api/session/")
	if !ok {
		notFound()
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	if r.Method != http.MethodGet {
		f.write(w, r, id, sub)
		return
	}
	switch sub {
	case "":
		if v, ok := f.sessions[id]; ok {
			w.Header().Set("Content-Type", "application/json")
			w.Write(v)
			return
		}
		notFound()
	case "permission", "form":
		src := f.permissions
		if sub == "form" {
			src = f.forms
		}
		if v, ok := src[id]; ok {
			w.Header().Set("Content-Type", "application/json")
			w.Write(v)
			return
		}
		reply(map[string]any{"data": []any{}})
	case "message":
		msgs, ok := f.messages[id]
		if !ok {
			notFound()
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if f.big > 0 && limit >= f.big {
			w.Write([]byte(`{"data":[{"id":"msg_a","type":"user","text":"`))
			w.Write([]byte(strings.Repeat("x", opencodeMessagesMax)))
			w.Write([]byte(`"}]}`))
			return
		}
		// Newest first from end (exclusive); the cursor is the index of the
		// newest message of the next page plus one.
		end := len(msgs)
		if c := r.URL.Query().Get("cursor"); c != "" {
			n, err := strconv.Atoi(strings.TrimPrefix(c, "older-"))
			if err != nil || n < 0 || n > len(msgs) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			end = n
		}
		start := max(0, end-limit)
		var page []json.RawMessage
		for i := end - 1; i >= start; i-- {
			page = append(page, msgs[i])
		}
		next := "older-" + strconv.Itoa(start)
		reply(map[string]any{"data": page, "cursor": map[string]any{"previous": "newer", "next": next}})
	default:
		notFound()
	}
}

// testOpencodeMessages reads a recorded page (newest first) as the session's
// messages, oldest first.
func testOpencodeMessages(t *testing.T, name string) []json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "opencode", name))
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &page); err != nil {
		t.Fatal(err)
	}
	// Recorded with order=asc unless the first is newer than the last.
	var first, last struct{ ID string }
	json.Unmarshal(page.Data[0], &first)
	json.Unmarshal(page.Data[len(page.Data)-1], &last)
	if first.ID > last.ID {
		for i, j := 0, len(page.Data)-1; i < j; i, j = i+1, j-1 {
			page.Data[i], page.Data[j] = page.Data[j], page.Data[i]
		}
	}
	return page.Data
}

func testOpencodeFixture(t *testing.T, name string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "opencode", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// write answers a write as OpenCode 2.3.0 does: a prompt to a session with
// messages; a reply to (or the cancel of) a request the session still holds,
// which drops it. A form answer holding "refuse" is refused (400), as one
// OpenCode finds invalid.
func (f *fakeOpencode) write(w http.ResponseWriter, r *http.Request, id, sub string) {
	body, _ := io.ReadAll(r.Body)
	f.bodies = append(f.bodies, string(body))
	if f.writeStatus != 0 {
		w.WriteHeader(f.writeStatus)
		w.Write([]byte(`{"_tag":"InternalError","message":"write words /home/user"}`))
		return
	}
	parts := strings.Split(sub, "/")
	switch {
	case r.Method == http.MethodPost && sub == "prompt":
		if _, ok := f.messages[id]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(testOpencodeFixture(f.t, "prompt-response.json"))
	case len(parts) >= 2 && (parts[0] == "permission" || parts[0] == "form"):
		src := f.permissions
		if parts[0] == "form" {
			src = f.forms
		}
		reply := len(parts) == 3 && parts[2] == "reply" && r.Method == http.MethodPost
		cancel := len(parts) == 2 && parts[0] == "form" && r.Method == http.MethodDelete
		if !reply && !cancel {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var list struct {
			Data []map[string]any `json:"data"`
		}
		json.Unmarshal(src[id], &list)
		i := slices.IndexFunc(list.Data, func(p map[string]any) bool { return p["id"] == parts[1] })
		if i < 0 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if parts[0] == "form" && strings.Contains(string(body), "refuse") {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"_tag":"FormInvalidAnswerError","message":"secret refusal words"}`))
			return
		}
		list.Data = slices.Delete(list.Data, i, i+1)
		src[id], _ = json.Marshal(list)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}
