package main

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fillSlotsButOne takes every slot of slots but one, and gives them back
// when the test ends.
func fillSlotsButOne(t *testing.T, slots chan struct{}) {
	t.Helper()
	for range cap(slots) - 1 {
		slots <- struct{}{}
	}
	t.Cleanup(func() {
		for len(slots) > 0 {
			<-slots
		}
	})
}

// viewReadable makes dir a repo tracking its files: a view-only client
// reads tracked files only.
func viewReadable(t *testing.T, dir string) {
	t.Helper()
	requireGit(t)
	gitInit(t, dir)
	gitAdd(t, dir)
}

// A view-only search never takes the last free slot; a full one does.
func TestFilesSearchViewLeavesLastSlot(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), "hit\n")
	viewReadable(t, root)
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, nil)
	fillSlotsButOne(t, f.searchSlots)
	const path = "/api/mux/panes/0/files/search?q=hit"
	rec := serve(mux, asView(apiRequest("GET", path, "")))
	if rec.Code != http.StatusTooManyRequests || decodeBody(t, rec)["code"] != "busy" {
		t.Errorf("view-only = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(mux, apiRequest("GET", path, "")); rec.Code != http.StatusOK {
		t.Errorf("full = %d %s", rec.Code, rec.Body)
	}
	if len(f.searchSlots) != cap(f.searchSlots)-1 {
		t.Errorf("slots held = %d", len(f.searchSlots))
	}
}

// contentAs is the content route's status for q, read by a view-only
// client when view is set.
func (fx *encFixture) contentAs(t *testing.T, view bool, q url.Values) (int, map[string]any) {
	t.Helper()
	req := apiRequest("GET", "/api/mux/panes/0/files/content?"+q.Encode(), "")
	if view {
		req = asView(req)
	}
	rec := serve(fx.mux, req)
	return rec.Code, decodeBody(t, rec)
}

func TestFilesContentLargeReadViewLeavesLastSlot(t *testing.T) {
	fx := newEncFixture(t)
	big := strings.Repeat("a\n", maxPreviewSize/2+1)
	if err := os.WriteFile(filepath.Join(fx.root, "big.txt"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	viewReadable(t, fx.root)
	fillSlotsButOne(t, fx.f.largeReadSlots)
	q := url.Values{"path": {"big.txt"}}
	if code, body := fx.contentAs(t, true, q); code != http.StatusTooManyRequests || body["code"] != "busy" {
		t.Errorf("view-only = %d %v", code, body["code"])
	}
	if code, body := fx.contentAs(t, false, q); code != http.StatusOK || body["text"] != big {
		t.Errorf("full = %d %v", code, body["code"])
	}
	if len(fx.f.largeReadSlots) != cap(fx.f.largeReadSlots)-1 {
		t.Errorf("slots held = %d", len(fx.f.largeReadSlots))
	}
}

func TestFilesContentDecodeViewLeavesLastSlot(t *testing.T) {
	fx := newEncFixture(t)
	viewReadable(t, fx.root)
	fillSlotsButOne(t, fx.f.decodeSlots)
	q := url.Values{"path": {"sjis.txt"}}
	if code, body := fx.contentAs(t, true, q); code != http.StatusTooManyRequests || body["code"] != "busy" {
		t.Errorf("view-only = %d %v", code, body["code"])
	}
	if code, body := fx.contentAs(t, false, q); code != http.StatusOK || body["encoding"] != "shift_jis" {
		t.Errorf("full = %d %v", code, body["code"])
	}
	if len(fx.f.decodeSlots) != cap(fx.f.decodeSlots)-1 {
		t.Errorf("slots held = %d", len(fx.f.decodeSlots))
	}
}

// A heavy git command for a view-only client waits rather than take the
// last free slot, and times out while it stays the last; a full client's
// runs.
func TestGitViewLeavesLastSlot(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	g := newGitRunner()
	g.timeout = 300 * time.Millisecond
	fillSlotsButOne(t, g.sem)
	call := gitCall{root: repo, heavy: true, noBackoff: true}
	view := withAuth(t.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d1"})
	if _, _, err := g.output(view, call, "status", "--porcelain"); !errors.Is(err, errGitTimeout) {
		t.Errorf("view-only = %v", err)
	}
	if _, _, err := g.output(t.Context(), call, "status", "--porcelain"); err != nil {
		t.Errorf("full = %v", err)
	}
	if len(g.sem) != cap(g.sem)-1 {
		t.Errorf("slots held = %d", len(g.sem))
	}

	// Once another slot frees, the waiting view-only command runs.
	g.timeout = 5 * time.Second
	done := make(chan error, 1)
	go func() {
		_, _, err := g.output(view, call, "status", "--porcelain")
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	<-g.sem
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("view-only after a slot freed = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("view-only never ran")
	}
}
