package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// opencodeImageMessage is a user message with files as OpenCode 2.3.0 keeps
// them (testdata/opencode/message-get-image.json): mime, source and data.
func opencodeImageMessage(id string, files ...map[string]any) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"id": id, "type": "user", "text": "look",
		"time": map[string]any{"created": 1794748975038}, "files": files})
	return data
}

func opencodeInline(mime string, data []byte) map[string]any {
	return map[string]any{"mime": mime, "name": "x", "source": map[string]any{"type": "inline"},
		"data": base64.StdEncoding.EncodeToString(data)}
}

// opencodeImagePane is a pane on sesPane whose messages hold every kind of
// file the image route has to tell apart, and a server with the transcript
// and image routes.
func opencodeImagePane(t *testing.T) (*fakeOpencode, http.Handler, transcriptResponse) {
	t.Helper()
	oc := newFakeOpencode(t)
	big := bytes.Repeat([]byte{0}, opencodeImageMax+1)
	copy(big, testImage(t, "image/png"))
	oc.set(func() {
		oc.messages["sesPane"] = []json.RawMessage{
			opencodeImageMessage("msg_a",
				opencodeInline("image/png", testImage(t, "image/png")),
				opencodeInline("text/plain", []byte("hello")),
				opencodeInline("image/png", []byte("not an image at all")),
				opencodeInline("image/png", testImage(t, "image/jpeg")),
				map[string]any{"mime": "image/png", "name": "y", "source": map[string]any{"type": "file", "path": "/etc/x"}},
				opencodeInline("image/png", big),
			),
		}
		oc.messages["sesOther"] = []json.RawMessage{opencodeImageMessage("msg_o", opencodeInline("image/png", testImage(t, "image/png")))}
	})
	a := newAgentAPI(nil)
	a.loc = fakeOpencodeLocator{AgentSession{Agent: "opencode", ID: "sesPane", Status: "idle"}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/mux/panes/{id}/agent/transcript", a.handleTranscript)
	mux.HandleFunc("/api/mux/panes/{id}/agent/image", a.handleImage)
	rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/agent/transcript", ""))
	var res transcriptResponse
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &res) != nil || len(res.Entries) != 1 {
		t.Fatalf("transcript = %d %s", rec.Code, rec.Body)
	}
	return oc, mux, res
}

func getOpencodeImage(h http.Handler, src string, view bool) *httptest.ResponseRecorder {
	path := "/api/mux/panes/0/agent/image?src=" + url.QueryEscape(src)
	req := apiRequest("GET", path, "")
	if view {
		req = viewRequest("GET", path, "")
	}
	return serve(h, req)
}

func TestOpencodeImage(t *testing.T) {
	oc, mux, res := opencodeImagePane(t)
	parts := res.Entries[0].Parts
	// The text file is no image; the one kept elsewhere is a chip without a
	// reference.
	var kinds []string
	for _, p := range parts {
		kinds = append(kinds, fmt.Sprintf("%s:%v", p.Kind, p.Image != ""))
	}
	if strings.Join(kinds, " ") != "text:false image:true image:true image:true image:false image:true" {
		t.Fatalf("parts = %v", kinds)
	}
	rec := getOpencodeImage(mux, parts[1].Image, false)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rec.Body.Bytes(), testImage(t, "image/png")) ||
		rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("image = %d %v", rec.Code, rec.Header())
	}
	// A view-only client sees the images too, as Claude Code's.
	if rec := getOpencodeImage(mux, parts[1].Image, true); rec.Code != 200 {
		t.Errorf("view-only = %d", rec.Code)
	}
	// Not an image, an image that is not what it claims, one over the limit,
	// one the message does not have.
	for name, ref := range map[string]string{
		"bytes":     parts[2].Image,
		"mismatch":  parts[3].Image,
		"too large": parts[5].Image,
		"text file": encodeImageRef(agentImageRef{Session: "sesPane", File: opencodeImageRefFile + "msg_a", N: 1}),
		"elsewhere": encodeImageRef(agentImageRef{Session: "sesPane", File: opencodeImageRefFile + "msg_a", N: 4}),
		"past end":  encodeImageRef(agentImageRef{Session: "sesPane", File: opencodeImageRefFile + "msg_a", N: 9}),
		"message":   encodeImageRef(agentImageRef{Session: "sesPane", File: opencodeImageRefFile + "msg_none", N: 0}),
		"unsigned":  "eyJzIjoic2VzUGFuZSJ9.AAAA",
	} {
		if rec := getOpencodeImage(mux, ref, false); rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "Message not found") {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	// Another session's image, signed by this server: never asked for, the
	// pane's directory having no history to list it.
	other := encodeImageRef(agentImageRef{Session: "sesOther", File: opencodeImageRefFile + "msg_o", N: 0})
	if rec := getOpencodeImage(mux, other, false); rec.Code != http.StatusNotFound {
		t.Errorf("other session = %d", rec.Code)
	}
	for _, r := range oc.reqs() {
		if strings.Contains(r, "sesOther") {
			t.Errorf("asked %s", r)
		}
	}
	// The service down: missing, never its words.
	oc.srv.Close()
	resetOpencodeCaches()
	if rec := getOpencodeImage(mux, parts[1].Image, false); rec.Code != http.StatusNotFound {
		t.Errorf("service down = %d", rec.Code)
	}
}

// A message holding two images near opencodeImageMax is over the limit of a
// page of messages, yet the Chat view reads it and each image of it is
// served: a page shrinks down to that one message, and one message is read
// with its own, larger limit.
func TestOpencodeImageLargeMessage(t *testing.T) {
	slowOpencodeReads(t)
	oc, mux, first := opencodeImagePane(t)
	images := make([][]byte, 2)
	files := make([]map[string]any, 2)
	for i := range images {
		images[i] = bytes.Repeat([]byte{byte(i + 1)}, opencodeImageMax-1024)
		copy(images[i], testImage(t, "image/png"))
		files[i] = opencodeInline("image/png", images[i])
	}
	msg := opencodeImageMessage("msg_big", files...)
	if len(msg) <= opencodeMessagesMax {
		t.Fatalf("message of %d bytes is not over a page's limit", len(msg))
	}
	oc.set(func() { oc.messages["sesPane"] = append(oc.messages["sesPane"], msg) })
	// A client that had the message before it: the new one, no reset.
	res := testOpencodeRead(t, "sesPane", "idle", first.Cursor, "")
	if res.Reset || len(res.Entries) != 1 || len(res.Entries[0].Parts) != 3 {
		t.Fatalf("after = reset %v, %+v", res.Reset, res.Entries)
	}
	for i, want := range images {
		ref := res.Entries[0].Parts[i+1].Image
		if rec := getOpencodeImage(mux, ref, false); rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("image %d = %d (%d bytes)", i, rec.Code, rec.Body.Len())
		}
	}
	// A poll finds nothing new; a first read gets that message alone and a
	// cursor to the one before.
	if again := testOpencodeRead(t, "sesPane", "idle", res.Cursor, ""); again.Reset || len(again.Entries) != 0 {
		t.Errorf("poll = reset %v, %d entries", again.Reset, len(again.Entries))
	}
	tail := testOpencodeRead(t, "sesPane", "idle", "", "")
	if !tail.Reset || len(tail.Entries) != 1 || tail.Before == "" {
		t.Errorf("tail = reset %v, %d entries, before %q", tail.Reset, len(tail.Entries), tail.Before)
	}

	// Six messages after it: read back one at a time past the large one,
	// no reset; a poll after that starts with one message, never asking
	// again for a page over the limit.
	oc.set(func() {
		for i := range 6 {
			oc.messages["sesPane"] = append(oc.messages["sesPane"], opencodeImageMessage(fmt.Sprintf("msg_n%d", i)))
		}
	})
	newer := testOpencodeRead(t, "sesPane", "idle", res.Cursor, "")
	if newer.Reset || len(newer.Entries) != 6 {
		t.Fatalf("six after it = reset %v, %d entries", newer.Reset, len(newer.Entries))
	}
	before := len(oc.reqs())
	if again := testOpencodeRead(t, "sesPane", "idle", newer.Cursor, ""); again.Reset || len(again.Entries) != 0 {
		t.Errorf("poll = reset %v, %d entries", again.Reset, len(again.Entries))
	}
	for _, r := range oc.reqs()[before:] {
		if !strings.Contains(r, "limit=1&") {
			t.Errorf("poll asked %s", r)
		}
	}
}

// slowOpencodeReads gives a test that moves tens of MB through the fake
// service a read timeout a loaded machine meets.
func slowOpencodeReads(t *testing.T) {
	prev := opencodeReadTimeout
	opencodeReadTimeout = time.Minute
	t.Cleanup(func() { opencodeReadTimeout = prev })
}

// A session of the history (an old one read in the history sheet) has its
// images served to a pane of its directory, whatever runs in the pane; a
// session the history does not list does not.
func TestOpencodeHistoryImage(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	fx.oc.set(func() {
		for _, id := range []string{"sesRoot", "ses_child1", "sesOut"} {
			fx.oc.messages[id] = []json.RawMessage{opencodeImageMessage("msg_h", opencodeInline("image/png", testImage(t, "image/png")))}
		}
	})
	code, body := getAPI(t, fx.h, "/api/mux/panes/0/agent/history/sesRoot/transcript?agent=opencode")
	raw, _ := json.Marshal(body)
	var res transcriptResponse
	json.Unmarshal(raw, &res)
	if code != 200 || len(res.Entries) != 1 || len(res.Entries[0].Parts) != 2 || res.Entries[0].Parts[1].Image == "" {
		t.Fatalf("history transcript = %d %v", code, body)
	}
	if rec := getOpencodeImage(fx.h, res.Entries[0].Parts[1].Image, false); rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" {
		t.Errorf("history image = %d %s", rec.Code, rec.Body)
	}
	for _, id := range []string{"ses_child1", "sesOut"} {
		ref := encodeImageRef(agentImageRef{Session: id, File: opencodeImageRefFile + "msg_h", N: 0})
		if rec := getOpencodeImage(fx.h, ref, false); rec.Code != http.StatusNotFound {
			t.Errorf("%s = %d", id, rec.Code)
		}
	}
	for _, r := range fx.oc.reqs() {
		if strings.Contains(r, "/message/") && !strings.Contains(r, "/sesRoot/") {
			t.Errorf("asked %s", r)
		}
	}
}

func TestOpencodeImageRef(t *testing.T) {
	for _, tc := range []struct {
		ref agentImageRef
		ok  bool
	}{
		{agentImageRef{Session: "sesA", File: "ocm:msg_a_3"}, true},
		{agentImageRef{Session: "sesA", File: "123:456"}, false},
		{agentImageRef{Session: "sesA", File: "ocm:../x"}, false},
		{agentImageRef{Session: "abc", File: "ocm:msg_a"}, false},
	} {
		if _, ok := opencodeImageRef(tc.ref); ok != tc.ok {
			t.Errorf("%+v = %v", tc.ref, ok)
		}
	}
}
