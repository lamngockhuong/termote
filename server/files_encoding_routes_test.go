package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// encFixture is a root holding every encoding fixture, behind the files
// routes.
type encFixture struct {
	root string
	f    *filesAPI
	mux  *http.ServeMux
}

func newEncFixture(t *testing.T) *encFixture {
	t.Helper()
	root := plainDir(t)
	ents, err := os.ReadDir(filepath.Join("testdata", "encoding"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if err := os.WriteFile(filepath.Join(root, e.Name()), encodingFixture(t, e.Name()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, nil)
	return &encFixture{root: root, f: f, mux: mux}
}

func (fx *encFixture) get(t *testing.T, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.mux, apiRequest("GET", "/api/mux/panes/0/files/content?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

func (fx *encFixture) put(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := apiRequest("PUT", "/api/mux/panes/0/files/content?root="+url.QueryEscape(fx.root), string(b))
	req.Header.Del("Origin")
	rec := serve(fx.mux, req)
	return rec.Code, decodeBody(t, rec)
}

// read is the content route's answer for name, which must be text.
func (fx *encFixture) read(t *testing.T, name string, q url.Values) map[string]any {
	t.Helper()
	if q == nil {
		q = url.Values{}
	}
	q.Set("path", name)
	code, body := fx.get(t, q)
	if code != 200 {
		t.Fatalf("%s = %d %v", name, code, body)
	}
	return body
}

func (fx *encFixture) bytesOf(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fx.root, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFilesContentEncodings(t *testing.T) {
	fx := newEncFixture(t)
	want := string(encodingFixture(t, "expected.txt"))
	for _, tc := range []struct {
		file, enc string
		bom       bool
		text      string
	}{
		{"expected.txt", "utf-8", false, want},
		{"utf8-bom.txt", "utf-8", true, want},
		{"sjis.txt", "shift_jis", false, want},
		{"sjis-crlf.txt", "shift_jis", false, strings.ReplaceAll(want, "\n", "\r\n")},
		{"eucjp.txt", "euc-jp", false, want},
		{"utf16le-bom.txt", "utf-16le", true, want},
		{"utf16be-bom.txt", "utf-16be", true, want},
	} {
		body := fx.read(t, tc.file, nil)
		raw := fx.bytesOf(t, tc.file)
		if body["encoding"] != tc.enc || (body["bom"] == true) != tc.bom || body["text"] != tc.text ||
			body["hash"] != hashHex(raw) || body["size"] != float64(len(raw)) || body["editable"] != true {
			t.Errorf("%s = %v", tc.file, body)
		}
	}
	// UTF-16 without a BOM is binary, until asked for.
	if _, body := fx.get(t, url.Values{"path": {"utf16le-nobom.txt"}}); body["reason"] != "binary" {
		t.Errorf("utf-16 without BOM = %v", body)
	}
	body := fx.read(t, "utf16le-nobom.txt", url.Values{"encoding": {"utf-16le"}})
	if body["text"] != want || body["encoding"] != "utf-16le" || body["bom"] != nil || body["editable"] != true {
		t.Errorf("utf-16le asked for = %v", body)
	}
	// Asked for UTF-8: no slot, the file as it is.
	if body := fx.read(t, "expected.txt", url.Values{"encoding": {"utf-8"}}); body["text"] != want {
		t.Errorf("utf-8 asked for = %v", body)
	}
	// Asked for an encoding, a NUL early on does not make it binary; the
	// decoded text with a NUL is shown, not edited.
	if err := os.WriteFile(filepath.Join(fx.root, "nul.txt"), []byte("a\x00\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	body = fx.read(t, "nul.txt", url.Values{"encoding": {"utf-16le"}})
	if body["text"] != "a\x00" || body["editable"] != false || body["notEditable"] != "nul" {
		t.Errorf("nul in utf-16 = %v", body)
	}
	body = fx.read(t, "sjis-lossy.txt", nil)
	if body["encoding"] != "shift_jis" || body["editable"] != false || body["notEditable"] != "lossy-encoding" {
		t.Errorf("lossy = %v", body)
	}
	if _, body := fx.get(t, url.Values{"path": {"latin1.txt"}}); body["reason"] != "binary" {
		t.Errorf("latin1 = %v", body)
	}
	if code, body := fx.get(t, url.Values{"path": {"sjis.txt"}, "encoding": {"xyz"}}); code != 400 {
		t.Errorf("unknown encoding = %d %v", code, body)
	}
	// The hash route never looks at the encoding.
	if code, body := fx.get(t, url.Values{"path": {"sjis.txt"}, "hash": {"1"}, "encoding": {"xyz"}}); code != 200 || body["hash"] != hashHex(fx.bytesOf(t, "sjis.txt")) {
		t.Errorf("hash = %d %v", code, body)
	}
	if len(fx.f.decodeSlots) != 0 {
		t.Errorf("slots held = %d", len(fx.f.decodeSlots))
	}
}

func TestFilesContentDecodeSlots(t *testing.T) {
	fx := newEncFixture(t)
	if err := os.WriteFile(filepath.Join(fx.root, ".env"), fx.bytesOf(t, "sjis.txt"), 0o644); err != nil {
		t.Fatal(err)
	}
	for range decodeMaxRunning {
		fx.f.decodeSlots <- struct{}{}
	}
	if code, body := fx.get(t, url.Values{"path": {"sjis.txt"}}); code != 429 || body["code"] != "busy" {
		t.Errorf("busy = %d %v", code, body)
	}
	if code, body := fx.get(t, url.Values{"path": {"utf16le-nobom.txt"}, "encoding": {"utf-16le"}}); code != 429 {
		t.Errorf("busy asked for = %d %v", code, body)
	}
	// A UTF-8 file needs no slot; a sensitive one is never decoded.
	if code, _ := fx.get(t, url.Values{"path": {"expected.txt"}}); code != 200 {
		t.Errorf("utf-8 while busy = %d", code)
	}
	if code, body := fx.get(t, url.Values{"path": {".env"}}); code != 200 || body["sensitive"] != true {
		t.Errorf("sensitive while busy = %d %v", code, body)
	}
	for range decodeMaxRunning {
		<-fx.f.decodeSlots
	}
	body := fx.read(t, ".env", url.Values{"reveal": {"1"}})
	if body["encoding"] != "shift_jis" {
		t.Errorf("revealed = %v", body)
	}
}

func TestFilesContentTooLargeAfterRead(t *testing.T) {
	fx := newEncFixture(t)
	if err := os.WriteFile(filepath.Join(fx.root, "big.txt"), make([]byte, maxPreviewSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, body := fx.get(t, url.Values{"path": {"big.txt"}}); body["reason"] != "too-large" {
		t.Errorf("too large = %v", body)
	}
}

// save reads name, then saves text read the same way.
func (fx *encFixture) save(t *testing.T, name, text string, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := fx.read(t, name, nil)
	req := map[string]any{"path": name, "baseHash": body["hash"], "text": text, "encoding": body["encoding"]}
	for k, v := range extra {
		req[k] = v
	}
	return fx.put(t, req)
}

func TestFilesWriteShiftJISKeepsBytes(t *testing.T) {
	fx := newEncFixture(t)
	before := fx.bytesOf(t, "sjis.txt")
	text := fx.read(t, "sjis.txt", nil)["text"].(string)
	lines := strings.Split(text, "\n")
	lines[1] = "ソフトを直しました。"
	code, body := fx.save(t, "sjis.txt", strings.Join(lines, "\n"), nil)
	if code != 200 || body["encoding"] != "shift_jis" || body["bom"] != nil {
		t.Fatalf("save = %d %v", code, body)
	}
	after := fx.bytesOf(t, "sjis.txt")
	if body["hash"] != hashHex(after) {
		t.Error("hash is not of the bytes written")
	}
	first := bytes.IndexByte(before, '\n') + 1
	last := bytes.IndexByte(before[first:], '\n') + first
	newLast := bytes.IndexByte(after[first:], '\n') + first
	if !bytes.Equal(before[:first], after[:first]) || !bytes.Equal(before[last:], after[newLast:]) {
		t.Errorf("bytes outside the edit changed:\n% x\n% x", before, after)
	}
	mid, _ := encodeText(lines[1], encShiftJIS, false)
	if !bytes.Equal(after[first:newLast], mid) {
		t.Errorf("edited line = % x", after[first:newLast])
	}
}

func TestFilesWriteKeepsLineBreaksAndBOM(t *testing.T) {
	fx := newEncFixture(t)
	for _, name := range []string{"sjis-crlf.txt", "utf16le-bom.txt", "utf8-bom.txt", "utf16be-bom.txt", "eucjp.txt"} {
		before := fx.bytesOf(t, name)
		text := fx.read(t, name, nil)["text"].(string)
		text = strings.ReplaceAll(text, "\r\n", "\n") + "追加\n"
		code, body := fx.save(t, name, text, nil)
		if code != 200 {
			t.Errorf("%s: save = %d %v", name, code, body)
			continue
		}
		after := fx.bytesOf(t, name)
		if !bytes.HasPrefix(after, before) {
			t.Errorf("%s: start changed", name)
		}
		got := fx.read(t, name, nil)
		if got["encoding"] != body["encoding"] || got["bom"] != body["bom"] {
			t.Errorf("%s: read back %v, saved %v", name, got, body)
		}
	}
	if !bytes.HasSuffix(fx.bytesOf(t, "sjis-crlf.txt"), []byte("\r\n")) {
		t.Error("CRLF not kept")
	}
	noEditTemps(t, fx.root)
}

func TestFilesWriteSaveAsUTF8(t *testing.T) {
	fx := newEncFixture(t)
	want := string(encodingFixture(t, "expected.txt"))
	before := fx.read(t, "sjis-crlf.txt", nil)
	req := map[string]any{
		"path": "sjis-crlf.txt", "baseHash": before["hash"], "text": strings.ReplaceAll(want, "\n", "\r\n"),
		"encoding": "shift_jis", "saveAs": "utf-8",
	}
	code, body := fx.put(t, req)
	crlf := strings.ReplaceAll(want, "\n", "\r\n")
	if code != 200 || body["encoding"] != "utf-8" || body["bom"] != nil || string(fx.bytesOf(t, "sjis-crlf.txt")) != crlf {
		t.Fatalf("save as utf-8 = %d %v", code, body)
	}
	// Sent again after a lost reply: the file is what it asks for already.
	if code, body := fx.put(t, req); code != 200 || body["encoding"] != "utf-8" {
		t.Errorf("again = %d %v", code, body)
	}
	// The same from UTF-16.
	b16 := fx.read(t, "utf16le-bom.txt", nil)
	req16 := map[string]any{"path": "utf16le-bom.txt", "baseHash": b16["hash"], "text": want, "encoding": "utf-16le", "saveAs": "utf-8"}
	if code, _ := fx.put(t, req16); code != 200 || string(fx.bytesOf(t, "utf16le-bom.txt")) != want {
		t.Fatalf("utf-16 as utf-8 = %d", code)
	}
	// Its UTF-16 decode finds no CRLF in UTF-8 bytes, so a CRLF file is
	// only matched by the second, other line breaks.
	if err := os.WriteFile(filepath.Join(fx.root, "utf16le-bom.txt"), []byte(crlf), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.put(t, req16); code != 200 {
		t.Errorf("crlf utf-8 already = %d %v", code, body)
	}
	// Neither: a conflict.
	if err := os.WriteFile(filepath.Join(fx.root, "utf16le-bom.txt"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.put(t, req16); code != 409 {
		t.Errorf("changed = %d %v", code, body)
	}
	// A lossy file can be saved as UTF-8 only.
	lossy := fx.read(t, "sjis-lossy.txt", nil)
	text := lossy["text"].(string)
	if code, body := fx.put(t, map[string]any{"path": "sjis-lossy.txt", "baseHash": lossy["hash"], "text": text, "encoding": "shift_jis"}); code != 422 || body["reason"] != "lossy-encoding" {
		t.Errorf("lossy in shift_jis = %d %v", code, body)
	}
	if code, body := fx.put(t, map[string]any{"path": "sjis-lossy.txt", "baseHash": lossy["hash"], "text": text, "encoding": "shift_jis", "saveAs": "utf-8"}); code != 200 || string(fx.bytesOf(t, "sjis-lossy.txt")) != text {
		t.Errorf("lossy as utf-8 = %d %v", code, body)
	}
	// Bytes not valid in the encoding would be lost: not even as UTF-8.
	bad := []byte("\xef\xbb\xbf\xe3\x81\x82\xe9\n")
	if err := os.WriteFile(filepath.Join(fx.root, "bad.txt"), bad, 0o644); err != nil {
		t.Fatal(err)
	}
	got := fx.read(t, "bad.txt", nil)
	if got["encoding"] != "utf-8" || got["bom"] != true || got["notEditable"] != "invalid-encoding" {
		t.Errorf("invalid utf-8 with a BOM = %v", got)
	}
	if code, body := fx.put(t, map[string]any{"path": "bad.txt", "baseHash": got["hash"], "text": got["text"], "encoding": "utf-8", "saveAs": "utf-8"}); code != 422 || body["reason"] != "invalid-encoding" {
		t.Errorf("invalid as utf-8 = %d %v", code, body)
	}
	if !bytes.Equal(fx.bytesOf(t, "bad.txt"), bad) {
		t.Error("refused save changed the file")
	}
	// A lossy file changed on the host: a conflict first.
	if err := os.WriteFile(filepath.Join(fx.root, "lossy2.txt"), encodingFixture(t, "sjis-lossy.txt"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.put(t, map[string]any{"path": "lossy2.txt", "baseHash": hashHex([]byte("old")), "text": "x", "encoding": "shift_jis"}); code != 409 || body["code"] != "changed" {
		t.Errorf("lossy changed = %d %v", code, body)
	}
}

func TestFilesWriteUnencodable(t *testing.T) {
	fx := newEncFixture(t)
	before := fx.bytesOf(t, "sjis.txt")
	text := fx.read(t, "sjis.txt", nil)["text"].(string)
	code, body := fx.save(t, "sjis.txt", text+"絵文字😀\n", nil)
	if code != 422 || body["code"] != "unencodable" || body["line"] != float64(4) || body["char"] != "😀" {
		t.Errorf("emoji = %d %v", code, body)
	}
	if !bytes.Equal(fx.bytesOf(t, "sjis.txt"), before) {
		t.Error("refused save changed the file")
	}
	noEditTemps(t, fx.root)
	// An Apple keyboard's wave dash is saved as Shift-JIS's.
	if code, body := fx.save(t, "sjis.txt", "〜\n", nil); code != 200 || !bytes.Equal(fx.bytesOf(t, "sjis.txt"), []byte{0x81, 0x60, '\n'}) {
		t.Errorf("wave dash = %d %v % x", code, body, fx.bytesOf(t, "sjis.txt"))
	}
	// Too large once encoded. (A file of ～ alone has no kana: it reads as
	// binary, so the request is built by hand.)
	big := map[string]any{"path": "sjis.txt", "baseHash": hashHex(fx.bytesOf(t, "sjis.txt")), "text": strings.Repeat("あ", maxPreviewSize/2+1), "encoding": "shift_jis"}
	if code, body := fx.put(t, big); code != 413 {
		t.Errorf("too large = %d %v", code, body)
	}
}

func TestFilesWriteLegacyClient(t *testing.T) {
	fx := newEncFixture(t)
	legacy := func(name, text string) (int, map[string]any) {
		return fx.put(t, map[string]any{"path": name, "baseHash": hashHex(fx.bytesOf(t, name)), "text": text})
	}
	before := fx.bytesOf(t, "sjis.txt")
	if code, body := legacy("sjis.txt", "上書き\n"); code != 422 || body["reason"] != "encoding-required" {
		t.Errorf("legacy on shift_jis = %d %v", code, body)
	}
	if !bytes.Equal(fx.bytesOf(t, "sjis.txt"), before) {
		t.Error("legacy save changed a Shift-JIS file")
	}
	if code, body := legacy("utf16le-bom.txt", "x\n"); code != 422 || body["reason"] != "encoding-required" {
		t.Errorf("legacy on utf-16 = %d %v", code, body)
	}
	want := string(encodingFixture(t, "expected.txt"))
	if code, body := legacy("utf8-bom.txt", want); code != 422 || body["reason"] != "encoding-required" {
		t.Errorf("legacy dropping the BOM = %d %v", code, body)
	}
	// An old draft still holds the BOM in its text.
	if code, body := legacy("utf8-bom.txt", "\uFEFF"+want+"x\n"); code != 200 || body["encoding"] != "utf-8" || body["bom"] != true {
		t.Errorf("legacy keeping the BOM = %d %v", code, body)
	}
	if !bytes.Equal(fx.bytesOf(t, "utf8-bom.txt"), append(encodingFixture(t, "utf8-bom.txt"), "x\n"...)) {
		t.Error("legacy BOM save changed other bytes")
	}
	if code, body := legacy("expected.txt", "plain\n"); code != 200 || body["encoding"] != "utf-8" || body["bom"] != nil {
		t.Errorf("legacy on utf-8 = %d %v", code, body)
	}
	if err := os.WriteFile(filepath.Join(fx.root, "mixed.txt"), []byte("a\r\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := legacy("mixed.txt", "a\n"); code != 422 || body["reason"] != "mixed-eol" {
		t.Errorf("legacy mixed = %d %v", code, body)
	}
	if code, body := legacy("expected.txt", strings.Repeat("a", maxPreviewSize+1)); code != 413 {
		t.Errorf("legacy too large = %d %v", code, body)
	}
}

func TestFilesWriteEncodingInput(t *testing.T) {
	fx := newEncFixture(t)
	hash := hashHex(fx.bytesOf(t, "sjis.txt"))
	for _, extra := range []map[string]any{
		{"encoding": "latin1"},
		{"encoding": "shift_jis", "saveAs": "latin1"},
		{"encoding": "shift_jis", "saveAs": "shift_jis"},
		{"saveAs": "utf-8"},
	} {
		req := map[string]any{"path": "sjis.txt", "baseHash": hash, "text": "x"}
		for k, v := range extra {
			req[k] = v
		}
		if code, body := fx.put(t, req); code != 400 {
			t.Errorf("%v = %d %v", extra, code, body)
		}
	}
	// A NUL in what the file decodes to: not edited.
	if err := os.WriteFile(filepath.Join(fx.root, "nul.txt"), []byte("a\x00\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.put(t, map[string]any{"path": "nul.txt", "baseHash": hashHex(fx.bytesOf(t, "nul.txt")), "text": "x", "encoding": "utf-16le"}); code != 422 || body["reason"] != "nul" {
		t.Errorf("nul = %d %v", code, body)
	}
}
