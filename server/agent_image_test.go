package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testPNG(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, c)
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// imageRow is a Claude Code user row with text and the given image blocks.
func imageRow(uuid string, blocks ...string) string {
	content := append([]string{`{"type":"text","text":"[Image #1] look"}`}, blocks...)
	return fmt.Sprintf(`{"type":"user","uuid":%q,"timestamp":"2026-11-14T00:00:00Z","message":{"role":"user","content":[%s]}}`+"\n",
		uuid, strings.Join(content, ","))
}

func imageBlock(mediaType string, data []byte) string {
	return fmt.Sprintf(`{"type":"image","source":{"type":"base64","media_type":%q,"data":%q}}`, mediaType, base64.StdEncoding.EncodeToString(data))
}

func getTranscriptRes(t *testing.T, mux http.Handler) transcriptResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/transcript", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("transcript = %d %s", rec.Code, rec.Body)
	}
	var res transcriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func imageRefs(res transcriptResponse) []string {
	var refs []string
	for _, e := range res.Entries {
		for _, p := range e.Parts {
			if p.Kind == "image" {
				refs = append(refs, p.Image)
			}
		}
	}
	return refs
}

func getImage(mux http.Handler, src string, edit func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/image?src="+url.QueryEscape(src), nil)
	if edit != nil {
		edit(req)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestAgentImageServesTranscriptImages(t *testing.T) {
	red, blue := testPNG(t, color.RGBA{255, 0, 0, 255}), testPNG(t, color.RGBA{0, 0, 255, 255})
	dir := t.TempDir()
	// A row longer than the transcript reader's line buffer still lists
	// its images: the reader clips the base64, the route reads it whole.
	big := bytes.Repeat([]byte{0}, agentMaxLine)
	big = append(append([]byte{}, red...), big...)
	writeTranscript(t, dir, testSessionID,
		imageRow("u1", imageBlock("image/png", red), imageBlock("image/png", blue))+
			imageRow("u2", imageBlock("image/png", big)))
	mux, _ := subagentsServer(t, claudeSession(dir))

	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 3 || refs[0] == "" || refs[1] == "" || refs[2] == "" {
		t.Fatalf("refs = %q", refs)
	}
	for i, want := range [][]byte{red, blue, big} {
		rec := getImage(mux, refs[i], nil)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), want) {
			t.Fatalf("image %d = %d (%d bytes)", i, rec.Code, rec.Body.Len())
		}
		h := rec.Header()
		if h.Get("Content-Type") != "image/png" || h.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.Contains(h.Get("Content-Security-Policy"), "sandbox") || !strings.HasPrefix(h.Get("Cache-Control"), "private") {
			t.Errorf("image %d headers = %v", i, h)
		}
	}

	// A view-only client sees the conversation, its images included.
	rec := getImage(mux, refs[0], func(r *http.Request) {
		*r = *r.WithContext(withAuth(r.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	})
	if rec.Code != http.StatusOK {
		t.Errorf("view-only = %d", rec.Code)
	}
	if rec := getImage(mux, refs[0], func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/mux/panes/p1/agent/image?src="+url.QueryEscape(refs[0]), nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
}

// Only an image beside words the user typed is listed: one set at the top
// of a row holding a tool's result, a notice or nothing else gets no part,
// so no reference agent/image would serve.
func TestClaudeImageListedOnlyBesideTypedText(t *testing.T) {
	red := testPNG(t, color.RGBA{255, 0, 0, 255})
	img := imageBlock("image/png", red)
	row := func(uuid string, blocks ...string) string {
		return fmt.Sprintf(`{"type":"user","uuid":%q,"message":{"role":"user","content":[%s]}}`+"\n", uuid, strings.Join(blocks, ","))
	}
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID,
		row("tool", `{"type":"tool_result","tool_use_id":"t1","content":"shot"}`, img)+
			row("alone", img)+
			row("notice", `{"type":"text","text":"<bash-stdout>x</bash-stdout>"}`, img)+
			imageRow("typed", img))
	mux, _ := subagentsServer(t, claudeSession(dir))
	res := getTranscriptRes(t, mux)
	for _, e := range res.Entries {
		for _, p := range e.Parts {
			if p.Kind == "image" && e.ID != "typed" {
				t.Errorf("entry %s lists an image", e.ID)
			}
		}
	}
	if refs := imageRefs(res); len(refs) != 1 || getImage(mux, refs[0], nil).Code != http.StatusOK {
		t.Errorf("typed row refs = %q", refs)
	}
}

// stalledWriter is a client that stopped reading: Write blocks until
// release is closed.
type stalledWriter struct {
	*httptest.ResponseRecorder
	writing chan struct{}
	release chan struct{}
}

func (w *stalledWriter) Write(b []byte) (int, error) {
	w.writing <- struct{}{}
	<-w.release
	return w.ResponseRecorder.Write(b)
}

// Clients that stopped reading hold no image slot: the slot bounds the read
// only, so another client's image is still served.
func TestAgentImageSlotNotHeldWhileWriting(t *testing.T) {
	red := testPNG(t, color.RGBA{255, 0, 0, 255})
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID, imageRow("u1", imageBlock("image/png", red)))
	mux, _ := subagentsServer(t, claudeSession(dir))
	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 1 {
		t.Fatalf("refs = %q", refs)
	}
	release := make(chan struct{})
	writing := make(chan struct{})
	done := make(chan struct{})
	for range agentImageConcurrency {
		go func() {
			defer func() { done <- struct{}{} }()
			w := &stalledWriter{httptest.NewRecorder(), writing, release}
			mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/image?src="+url.QueryEscape(refs[0]), nil))
		}()
	}
	for range agentImageConcurrency {
		<-writing
	}
	rec := getImage(mux, refs[0], nil)
	close(release)
	for range agentImageConcurrency {
		<-done
	}
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), red) {
		t.Fatalf("image while others stall = %d %s", rec.Code, rec.Body)
	}
}

// A slash command's row holds only the command; its images are in the
// isMeta row that expands it, right after. They show on the command, and
// the route serves them from that row. Another meta row's images, and a
// meta row after anything but its command, stay hidden.
func TestAgentImageOfSlashCommand(t *testing.T) {
	red, blue := testPNG(t, color.RGBA{255, 0, 0, 255}), testPNG(t, color.RGBA{0, 0, 255, 255})
	dir := t.TempDir()
	command := func(uuid string) string {
		return fmt.Sprintf(`{"type":"user","uuid":%q,"message":{"role":"user","content":"<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>look [Image #1] here</command-args>"}}`+"\n", uuid)
	}
	meta := func(uuid, parent, block string) string {
		return fmt.Sprintf(`{"type":"user","uuid":%q,"parentUuid":%q,"isMeta":true,"message":{"role":"user","content":[%s,{"type":"text","text":"Fix this: look [Image #1] here"}]}}`+"\n", uuid, parent, block)
	}
	writeTranscript(t, dir, testSessionID,
		command("c1")+meta("m1", "c1", imageBlock("image/png", red))+
			// A second meta row of the same command adds nothing
			meta("m2", "m1", imageBlock("image/png", blue))+
			// After a plain message, and after another command
			imageRow("u1")+meta("m3", "u1", imageBlock("image/png", blue))+
			command("c2")+meta("m4", "other", imageBlock("image/png", blue)))
	mux, _ := subagentsServer(t, claudeSession(dir))
	res := getTranscriptRes(t, mux)
	if len(res.Entries) != 3 {
		t.Fatalf("entries = %+v", res.Entries)
	}
	cmd := res.Entries[0]
	if cmd.Role != "user" || len(cmd.Parts) != 2 || cmd.Parts[0].Text != "/fix look [Image #1] here" || cmd.Parts[1].Kind != "image" {
		t.Fatalf("command = %+v", cmd)
	}
	refs := imageRefs(res)
	if len(refs) != 1 {
		t.Fatalf("refs = %q", refs)
	}
	if rec := getImage(mux, refs[0], nil); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), red) {
		t.Fatalf("image = %d (%d bytes)", rec.Code, rec.Body.Len())
	}
}

func TestAgentImageRefusesForgedOrStaleRefs(t *testing.T) {
	png := testPNG(t, color.Black)
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, imageRow("u1", imageBlock("image/png", png)))
	mux, _ := subagentsServer(t, claudeSession(dir))
	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 1 {
		t.Fatalf("refs = %q", refs)
	}
	ref, ok := decodeImageRef(refs[0])
	if !ok {
		t.Fatal("ref does not decode")
	}

	// A cursor is signed with the same key but never passes for an image.
	cursor := encodeCursor(agentCursor{Session: ref.Session, Offset: ref.Offset, File: ref.File})
	unsigned := base64.RawURLEncoding.EncodeToString([]byte(`{"s":"`+ref.Session+`","f":"`+ref.File+`","o":0,"n":0}`)) + ".AAAA"
	for name, src := range map[string]string{
		"empty":          "",
		"junk":           "nope",
		"cursor":         cursor,
		"unsigned":       unsigned,
		"other session":  encodeImageRef(agentImageRef{Session: "00000000-0000-4000-8000-000000000000", File: ref.File, N: 0}),
		"other file":     encodeImageRef(agentImageRef{Session: ref.Session, File: "other", N: 0}),
		"not line start": encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, Offset: 5, N: 0}),
		"past end":       encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, Offset: 1 << 30, N: 0}),
		"no such image":  encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, N: 1}),
	} {
		if rec := getImage(mux, src, nil); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"not_found"`) {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}

	// The transcript replaced by another file of the same name (written
	// before the rename, so it cannot reuse the old inode)
	if err := os.WriteFile(p+".new", []byte(imageRow("u1", imageBlock("image/png", png))), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p+".new", p); err != nil {
		t.Fatal(err)
	}
	if rec := getImage(mux, refs[0], nil); rec.Code != http.StatusNotFound && fileIdentityKnown() {
		t.Errorf("replaced file = %d", rec.Code)
	}
}

// fileIdentityKnown: the platform names a file by device and inode, so a
// file replaced under the same name is another one.
func fileIdentityKnown() bool {
	fi, err := os.Stat(os.TempDir())
	return err == nil && fileIdentity(fi) != ""
}

func TestClaudeImageAcceptsOnlyRealImages(t *testing.T) {
	png := testPNG(t, color.White)
	html := []byte("<html><script>alert(1)</script></html>")
	for name, tc := range map[string]struct {
		line string
		n    int
		ok   bool
	}{
		"png":                   {imageRow("u", imageBlock("image/png", png)), 0, true},
		"no media type":         {imageRow("u", `{"type":"image","source":{"type":"base64","data":"`+base64.StdEncoding.EncodeToString(png)+`"}}`), 0, true},
		"html as png":           {imageRow("u", imageBlock("image/png", html)), 0, false},
		"png named jpeg":        {imageRow("u", imageBlock("image/jpeg", png)), 0, false},
		"svg":                   {imageRow("u", imageBlock("image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))), 0, false},
		"url source":            {imageRow("u", `{"type":"image","source":{"type":"url","url":"http://example.com/a.png"}}`), 0, false},
		"bad base64":            {imageRow("u", `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"!!"}}`), 0, false},
		"second of one":         {imageRow("u", imageBlock("image/png", png)), 1, false},
		"string content":        {`{"type":"user","message":{"role":"user","content":"hi"}}`, 0, false},
		"not json":              {"{", 0, false},
		"image after non-image": {imageRow("u", `{"type":"text","text":"x"}`, imageBlock("image/png", png)), 0, true},
	} {
		mt, data, ok := claudeImage([]byte(tc.line), tc.n)
		if ok != tc.ok || (ok && (mt != "image/png" || !bytes.Equal(data, png))) {
			t.Errorf("%s = %q %d bytes %v", name, mt, len(data), ok)
		}
	}
}

// codexInput is the response_item row Codex writes before a UserMessage
// item: the model's input, a user message whose images are data: URLs, each
// wrapped like a pasted file.
func codexInput(urls ...string) string {
	content := []any{}
	for i, u := range urls {
		content = append(content,
			map[string]any{"type": "input_text", "text": fmt.Sprintf(`<image name=[Image #%d] path="/tmp/p%d.png">`, i+1, i)},
			map[string]any{"type": "input_image", "image_url": u, "detail": "high"},
			map[string]any{"type": "input_text", "text": "</image>"})
	}
	content = append(content, map[string]any{"type": "input_text", "text": "look"})
	b, _ := json.Marshal(map[string]any{"timestamp": "2026-11-14T00:00:00Z", "type": "response_item",
		"payload": map[string]any{"type": "message", "role": "user", "content": content}})
	return string(b) + "\n"
}

func dataURL(mediaType string, data []byte) string {
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
}

// codexImageMessage is a UserMessage item with the given image items and text.
func codexImageMessage(id string, images ...map[string]any) string {
	content := []any{}
	for _, im := range images {
		content = append(content, im)
	}
	content = append(content, map[string]any{"type": "text", "text": "[Image #1] look"})
	return codexItemRow(map[string]any{"type": "UserMessage", "id": id, "content": content})
}

func codexLocalImage(path string) map[string]any {
	return map[string]any{"type": "local_image", "path": path}
}

func codexImageServer(t *testing.T, rows string) (http.Handler, []string) {
	t.Helper()
	home := t.TempDir()
	p := writeRollout(t, home, testCodexID, rows)
	s := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: home, Rollout: p, RolloutID: rolloutIdentity(p, nil, mustStat(t, p))}
	mux, _ := subagentsServer(t, s)
	return mux, imageRefs(getTranscriptRes(t, mux))
}

func TestAgentImageServesCodexImages(t *testing.T) {
	red, blue := testPNG(t, color.RGBA{255, 0, 0, 255}), testPNG(t, color.RGBA{0, 0, 255, 255})
	// An input row longer than a tail chunk and the line buffer: the row
	// before the item is read back over many reads.
	big := append(append([]byte{}, red...), bytes.Repeat([]byte{0}, agentMaxLine)...)
	// A file on the host the item names: never read, only the rollout's copy.
	secret := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(secret, blue, 0o600); err != nil {
		t.Fatal(err)
	}
	rows := codexEvent(map[string]any{"type": "task_started"}) +
		codexInput(dataURL("image/png", red), dataURL("image/png", blue)) +
		codexImageMessage("m1", codexLocalImage(secret), map[string]any{"type": "image", "image_url": dataURL("image/png", blue)}) +
		codexInput(dataURL("image/png", big)) +
		codexImageMessage("m2", codexLocalImage("/tmp/big.png"))
	mux, refs := codexImageServer(t, rows)
	if len(refs) != 3 || slices.Contains(refs, "") {
		t.Fatalf("refs = %q", refs)
	}
	for i, want := range [][]byte{red, blue, big} {
		rec := getImage(mux, refs[i], nil)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), want) {
			t.Fatalf("image %d = %d (%d bytes)", i, rec.Code, rec.Body.Len())
		}
		if h := rec.Header(); h.Get("Content-Type") != "image/png" || h.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("image %d headers = %v", i, h)
		}
	}
	ref, _ := decodeImageRef(refs[0])
	if rec := getImage(mux, encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, Offset: ref.Offset, N: 2}), nil); rec.Code != http.StatusNotFound {
		t.Errorf("third of two = %d", rec.Code)
	}
}

func TestAgentImageRefusesUnmatchedCodexInput(t *testing.T) {
	png := testPNG(t, color.Black)
	other := codexEvent(map[string]any{"type": "agent_message", "message": "x"})
	for name, rows := range map[string]string{
		// Codex could not read one file: the input has fewer images than
		// the item, so no image is served under another's chip.
		"fewer input images": codexInput(dataURL("image/png", png)) + codexImageMessage("m", codexLocalImage("/a.png"), codexLocalImage("/b.png")),
		"row in between":     codexInput(dataURL("image/png", png)) + other + codexImageMessage("m", codexLocalImage("/a.png")),
		"no row before":      codexImageMessage("m", codexLocalImage("/a.png")),
		"assistant input": strings.Replace(codexInput(dataURL("image/png", png)), `"role":"user"`, `"role":"assistant"`, 1) +
			codexImageMessage("m", codexLocalImage("/a.png")),
		"http url":    codexInput("https://example.com/a.png") + codexImageMessage("m", map[string]any{"type": "image", "image_url": "https://example.com/a.png"}),
		"html as png": codexInput(dataURL("image/png", []byte("<html><script>alert(1)</script></html>"))) + codexImageMessage("m", codexLocalImage("/a.png")),
		"svg": codexInput(dataURL("image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))) +
			codexImageMessage("m", codexLocalImage("/a.svg")),
		"png named jpeg": codexInput(dataURL("image/jpeg", png)) + codexImageMessage("m", codexLocalImage("/a.jpg")),
		"not base64":     codexInput("data:image/png,"+string(png[:8])) + codexImageMessage("m", codexLocalImage("/a.png")),
		"bad base64":     codexInput("data:image/png;base64,!!") + codexImageMessage("m", codexLocalImage("/a.png")),
	} {
		mux, refs := codexImageServer(t, rows)
		if len(refs) == 0 {
			t.Fatalf("%s: no image part", name)
		}
		for _, ref := range refs {
			if rec := getImage(mux, ref, nil); rec.Code != http.StatusNotFound {
				t.Errorf("%s = %d", name, rec.Code)
			}
		}
	}
}

func TestCodexImageReadsOnlyUserMessages(t *testing.T) {
	png := testPNG(t, color.White)
	input := codexInput(dataURL("image/png", png))
	for name, tc := range map[string]struct {
		rows string
		ok   bool
	}{
		"user message":  {input + codexImageMessage("m", codexLocalImage("/a.png")), true},
		"agent message": {input + codexItemRow(map[string]any{"type": "AgentMessage", "content": []any{codexLocalImage("/a.png")}}), false},
		"not json":      {input + "{\n", false},
		"no newline":    {input + strings.TrimSuffix(codexImageMessage("m", codexLocalImage("/a.png")), "\n"), false},
	} {
		f := strings.NewReader(tc.rows)
		off := int64(len(input))
		mt, data, ok := codexJournal{}.Image(f, off, int64(len(tc.rows)), 0)
		if ok != tc.ok || (ok && (mt != "image/png" || !bytes.Equal(data, png))) {
			t.Errorf("%s = %q %d bytes %v", name, mt, len(data), ok)
		}
	}
	if _, _, ok := (codexJournal{}).Image(strings.NewReader(input), 0, int64(len(input)), 0); ok {
		t.Error("input row read as an item")
	}
}

func TestRowBefore(t *testing.T) {
	long := strings.Repeat("x", 200<<10)
	rows := "a\n" + long + "\n" + "\n" + "c\n"
	f := strings.NewReader(rows)
	for _, tc := range []struct {
		off  int64
		want string
		ok   bool
	}{
		{0, "", false},
		{2, "a\n", true},
		{int64(2 + len(long) + 1), long + "\n", true},
		{int64(2 + len(long) + 2), "\n", true},
	} {
		got, ok := rowBefore(f, tc.off)
		if ok != tc.ok || string(got) != tc.want {
			t.Errorf("rowBefore(%d) = %d bytes %v", tc.off, len(got), ok)
		}
	}
	// A row longer than the limit is not read back, whether the limit is
	// passed while looking for its start or the file starts it.
	for _, n := range []int{agentImageLineMax, agentImageLineMax + 1} {
		huge := strings.Repeat("y", n) + "\n"
		if _, ok := rowBefore(strings.NewReader(huge), int64(len(huge))); ok {
			t.Errorf("row of %d bytes read", n+1)
		}
	}
}

type failingReaderAt struct{}

func (failingReaderAt) ReadAt([]byte, int64) (int, error) { return 0, os.ErrClosed }

func TestRowReadsRefuseBadRanges(t *testing.T) {
	r := strings.NewReader("a\nb")
	if _, ok := rowAt(r, 3, 3); ok {
		t.Error("rowAt past the end")
	}
	if _, ok := rowAt(r, -1, 3); ok {
		t.Error("rowAt before the start")
	}
	if _, ok := rowAt(r, 2, 3); ok {
		t.Error("rowAt a row without '\\n'")
	}
	if _, _, ok := (claudeJournal{}).Image(r, 2, 3, 0); ok {
		t.Error("claude image of a partial row")
	}
	if _, ok := rowBefore(failingReaderAt{}, 5); ok {
		t.Error("rowBefore on a failing read")
	}
	if _, ok := rowBefore(failingReaderAt{}, 1); ok {
		t.Error("rowBefore of an empty first row on a failing read")
	}
}
