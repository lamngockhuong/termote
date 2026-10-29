package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// putEntry writes an entry straight into the trash: its record, and for a
// file or a discard a payload holding text.
func (fx *trashFixture) putEntry(t *testing.T, root, rel, kind string, at time.Time) string {
	t.Helper()
	s := fx.trash()
	id := randomHex(16)
	if kind != "dir" {
		writeFile(t, filepath.Join(fx.trashDir, id), "payload\n")
	}
	s.mu.Lock()
	err := s.writeRecordLocked(id, trashRecord{Root: root, Path: rel, Kind: kind, DeletedAt: at, Size: 8})
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (fx *trashFixture) listQuery() url.Values { return url.Values{"root": {fx.root}} }

// listIDs lists the root's trash through the route.
func (fx *trashFixture) listIDs(t *testing.T) []string {
	t.Helper()
	code, body := fx.get(t, "trash", fx.listQuery())
	if code != 200 {
		t.Fatalf("list = %d %v", code, body)
	}
	var ids []string
	for _, e := range body["entries"].([]any) {
		ids = append(ids, e.(map[string]any)["trashId"].(string))
	}
	return ids
}

// asView is req from a view-only device, same-site.
func asView(req *http.Request) *http.Request {
	req.Header.Del("Origin")
	return req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d1"}))
}

func TestTrashList(t *testing.T) {
	fx := newTrashFixture(t)
	now := time.Now()
	old := fx.putEntry(t, fx.root, "old.txt", "file", now.Add(-2*time.Hour))
	dir := fx.putEntry(t, fx.root, "gone", "dir", now.Add(-time.Hour))
	discard := fx.putEntry(t, fx.root, ".env", "discard", now.Add(-time.Minute))
	// Left out: another root, past maxAge, a payload gone, a payload that is
	// a symlink, an unknown kind, a file whose restore died half done.
	fx.putEntry(t, filepath.Join(fx.root, "sub"), "x.txt", "file", now)
	fx.putEntry(t, fx.root, "expired.txt", "file", now.Add(-trashMaxAge-time.Minute))
	missing := fx.putEntry(t, fx.root, "missing.txt", "file", now)
	os.Remove(filepath.Join(fx.trashDir, missing))
	link := fx.putEntry(t, fx.root, "link.txt", "file", now)
	os.Remove(filepath.Join(fx.trashDir, link))
	if err := os.Symlink(filepath.Join(fx.root, "elsewhere"), filepath.Join(fx.trashDir, link)); err != nil {
		t.Skip("no symlinks:", err)
	}
	fx.putEntry(t, fx.root, "odd", "fifo", now)
	half := fx.putEntry(t, fx.root, "back.txt", "file", now)
	if err := os.Link(filepath.Join(fx.trashDir, half), filepath.Join(fx.root, "back.txt")); err != nil {
		t.Skip("no hard links:", err)
	}
	// Names the store never makes are not read.
	writeFile(t, filepath.Join(fx.trashDir, "notes.json"), "{}")
	writeFile(t, filepath.Join(fx.trashDir, strings.Repeat("a", 32)+".json.part"), "{")

	code, body := fx.get(t, "trash", fx.listQuery())
	if code != 200 || body["root"] != fx.root || body["truncated"] != nil {
		t.Fatalf("list = %d %v", code, body)
	}
	entries := body["entries"].([]any)
	var got []string
	for _, e := range entries {
		got = append(got, e.(map[string]any)["trashId"].(string))
	}
	if strings.Join(got, ",") != strings.Join([]string{discard, dir, old}, ",") {
		t.Fatalf("ids = %v, want discard, dir, old (newest first)", got)
	}
	first := entries[0].(map[string]any)
	if first["path"] != ".env" || first["kind"] != "discard" || first["sensitive"] != true || first["size"] != float64(8) {
		t.Errorf("discard entry = %v", first)
	}
	deleted, _ := time.Parse(time.RFC3339Nano, first["deletedAt"].(string))
	expires, _ := time.Parse(time.RFC3339Nano, first["expiresAt"].(string))
	if expires.Sub(deleted) != trashMaxAge {
		t.Errorf("expiresAt - deletedAt = %v", expires.Sub(deleted))
	}
	if e := entries[2].(map[string]any); e["sensitive"] != nil || e["kind"] != "file" {
		t.Errorf("file entry = %v", e)
	}
	// Listing removes nothing, not even what the sweep would.
	if !fx.trashHas(link) || !fx.trashHas(half) || !fx.trashHas(missing+".json") {
		t.Error("the list removed an entry")
	}

	// An empty trash lists [], never null.
	other := newTrashFixture(t)
	if code, body := other.get(t, "trash", other.listQuery()); code != 200 || len(body["entries"].([]any)) != 0 {
		t.Errorf("empty list = %d %v", code, body)
	}
}

func TestTrashListTruncates(t *testing.T) {
	fx := newTrashFixture(t)
	base := time.Now().Add(-time.Hour)
	var newest string
	for i := range trashListMax + 100 {
		id := fx.putEntry(t, fx.root, fmt.Sprintf("f%d.txt", i), "file", base.Add(time.Duration(i)*time.Second))
		newest = id
	}
	code, body := fx.get(t, "trash", fx.listQuery())
	entries := body["entries"].([]any)
	if code != 200 || body["truncated"] != true || len(entries) != trashListMax {
		t.Fatalf("list = %d truncated=%v len=%d", code, body["truncated"], len(entries))
	}
	if entries[0].(map[string]any)["trashId"] != newest {
		t.Error("not newest first")
	}
}

func TestTrashListErrors(t *testing.T) {
	fx := newTrashFixture(t)
	fx.putEntry(t, fx.root, "a.txt", "file", time.Now())
	path := "/api/mux/panes/0/files/trash"
	q := "?root=" + url.QueryEscape(fx.root)
	cross := apiRequest("GET", path+q, "")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.Header.Set("Origin", "https://evil.example")
	for name, c := range map[string]struct {
		req  *http.Request
		want int
	}{
		"no root":    {apiRequest("GET", path, ""), http.StatusBadRequest},
		"post":       {apiRequest("POST", path+q, "{}"), http.StatusMethodNotAllowed},
		"root moved": {apiRequest("GET", path+"?root=/elsewhere", ""), http.StatusConflict},
		"cross-site": {cross, http.StatusForbidden},
	} {
		if rec := serve(fx.mux, c.req); rec.Code != c.want {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	assertViewOnly(t, "view list", serve(fx.mux, asView(apiRequest("GET", path+q, ""))))

	// Every raw slot taken: 429, never a wait.
	for range cap(fx.f.rawSlots) {
		fx.f.rawSlots <- struct{}{}
	}
	if code, body := fx.get(t, "trash", fx.listQuery()); code != 429 || body["code"] != "busy" {
		t.Errorf("slots full = %d %v", code, body)
	}
	for range cap(fx.f.rawSlots) {
		<-fx.f.rawSlots
	}

	// The store dir gone: logged, answered generically.
	os.RemoveAll(fx.trashDir)
	if code, body := fx.get(t, "trash", fx.listQuery()); code != 503 || body["code"] != "trash_unavailable" {
		t.Errorf("unreadable trash = %d %v", code, body)
	}

	fx.f.trash = nil
	for _, route := range []string{"trash", "trash/delete", "trash/empty"} {
		method, body := "POST", `{"trashId":"x","trashIds":["x"]}`
		if route == "trash" {
			method, body = "GET", ""
		}
		req := apiRequest(method, "/api/mux/panes/0/files/"+route+q, body)
		req.Header.Del("Origin")
		rec := serve(fx.mux, req)
		if rec.Code != 503 || decodeBody(t, rec)["code"] != "trash_unavailable" {
			t.Errorf("%s without a trash = %d %s", route, rec.Code, rec.Body)
		}
	}
}

func TestTrashDelete(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	_, body := fx.deleteOK(t, "a.txt")
	id := body["trashId"].(string)
	// Deleted a moment ago, younger than trashMinAge: still removed.
	code, body := fx.post(t, "trash/delete", map[string]any{"trashId": id})
	if code != 200 || body["root"] != fx.root || body["trashId"] != id {
		t.Fatalf("delete = %d %v", code, body)
	}
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash after delete = %v", names)
	}
	if code, body := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("again = %d %v", code, body)
	}
	if code, _ := fx.post(t, "trash/delete", map[string]any{"trashId": "../x"}); code != 400 {
		t.Errorf("bad id = %d", code)
	}
	// Deleted under another root: 404 as if missing, and it stays.
	other := fx.putEntry(t, filepath.Join(fx.root, "sub"), "b.txt", "file", time.Now())
	if code, body := fx.post(t, "trash/delete", map[string]any{"trashId": other}); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("other root = %d %v", code, body)
	}
	if !fx.trashHas(other) || !fx.trashHas(other+".json") {
		t.Error("another root's entry was removed")
	}
	// A directory has no payload; a payload that is a symlink is never
	// followed or removed, only the record goes.
	dir := fx.putEntry(t, fx.root, "d", "dir", time.Now())
	if code, _ := fx.post(t, "trash/delete", map[string]any{"trashId": dir}); code != 200 || fx.trashHas(dir+".json") {
		t.Errorf("dir = %d", code)
	}
	link := fx.putEntry(t, fx.root, "l.txt", "file", time.Now())
	os.Remove(filepath.Join(fx.trashDir, link))
	target := filepath.Join(fx.root, "target.txt")
	writeFile(t, target, "keep\n")
	if err := os.Symlink(target, filepath.Join(fx.trashDir, link)); err == nil {
		if code, _ := fx.post(t, "trash/delete", map[string]any{"trashId": link}); code != 200 {
			t.Errorf("symlink payload = %d", code)
		}
		if readText(t, target) != "keep\n" || !fx.trashHas(link) {
			t.Error("a symlink payload was followed or removed")
		}
	}
	assertViewOnly(t, "view delete", serve(fx.mux, asView(apiRequest("POST", "/api/mux/panes/0/files/trash/delete?root="+url.QueryEscape(fx.root), `{"trashId":"`+other+`"}`))))
}

func TestTrashDeletePayloadFails(t *testing.T) {
	fx := newTrashFixture(t)
	id := fx.putEntry(t, fx.root, "a.txt", "file", time.Now())
	setFindHook(t, &trashPurge, func(*os.Root, string) error { return errors.New("busy file") })
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	if code, body := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 500 || body["error"] != "files request failed" {
		t.Errorf("delete = %d %v", code, body)
	}
	if !fx.trashHas(id) || !fx.trashHas(id+".json") {
		t.Error("the record went with the payload still there")
	}
	if ids := fx.listIDs(t); len(ids) != 1 || ids[0] != id {
		t.Errorf("list after a failed delete = %v", ids)
	}
	code, body := fx.post(t, "trash/empty", map[string]any{"trashIds": []string{id}})
	if code != 200 || body["removed"] != float64(0) || body["failed"] != float64(1) {
		t.Errorf("empty = %d %v", code, body)
	}
	if strings.Contains(logs.String(), "busy file") == false {
		t.Error("the failure was not logged")
	}
	// A payload already gone is not a failure.
	setFindHook(t, &trashPurge, func(*os.Root, string) error { return os.ErrNotExist })
	if code, _ := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 200 || fx.trashHas(id+".json") {
		t.Errorf("payload gone = %d", code)
	}
}

func TestTrashEmpty(t *testing.T) {
	fx := newTrashFixture(t)
	now := time.Now()
	a := fx.putEntry(t, fx.root, "a.txt", "file", now)
	b := fx.putEntry(t, fx.root, "b", "dir", now)
	listed := fx.listIDs(t)
	// Deleted after the list (another device's Undo): never in the body,
	// so it stays.
	later := fx.putEntry(t, fx.root, "later.txt", "file", now)
	other := fx.putEntry(t, filepath.Join(fx.root, "sub"), "c.txt", "file", now)
	gone := randomHex(16)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	code, body := fx.post(t, "trash/empty", map[string]any{"trashIds": append(listed, other, gone)})
	if code != 200 || body["root"] != fx.root || body["removed"] != float64(2) || body["failed"] != float64(0) {
		t.Fatalf("empty = %d %v", code, body)
	}
	for _, id := range []string{a, b} {
		if fx.trashHas(id + ".json") {
			t.Errorf("%s still there", id)
		}
	}
	if !fx.trashHas(later) || !fx.trashHas(later+".json") || !fx.trashHas(other+".json") {
		t.Error("empty removed an entry it was not sent, or another root's")
	}
	line := logs.String()
	if !strings.Contains(line, `audit: trash-empty removed="2" failed="0"`) || strings.Contains(line, fx.root) || strings.Contains(line, "a.txt") {
		t.Errorf("audit line = %q", line)
	}

	many := make([]string, trashListMax+1)
	for i := range many {
		many[i] = randomHex(16)
	}
	for name, ids := range map[string][]string{
		"none":     {},
		"too many": many,
		"bad id":   {a, "nope"},
	} {
		if code, _ := fx.post(t, "trash/empty", map[string]any{"trashIds": ids}); code != 400 {
			t.Errorf("%s = %d", name, code)
		}
	}
	// trashListMax ids fit the body.
	if code, body := fx.post(t, "trash/empty", map[string]any{"trashIds": many[:trashListMax]}); code != 200 || body["removed"] != float64(0) {
		t.Errorf("500 ids = %d %v", code, body)
	}
	assertViewOnly(t, "view empty", serve(fx.mux, asView(apiRequest("POST", "/api/mux/panes/0/files/trash/empty?root="+url.QueryEscape(fx.root), `{"trashIds":["`+later+`"]}`))))
	if !fx.trashHas(later) {
		t.Error("a view-only empty removed an entry")
	}
}

func TestTrashDeleteAudit(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "secret-name.txt", "x\n")
	_, body := fx.deleteOK(t, "secret-name.txt")
	id := body["trashId"].(string)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	if code, _ := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 200 {
		t.Fatal(code)
	}
	line := logs.String()
	if !strings.Contains(line, `audit: trash-delete id="`+id+`"`) || strings.Contains(line, "secret-name") || strings.Contains(line, fx.root) {
		t.Errorf("audit line = %q", line)
	}
}

func TestTrashRoutesGuards(t *testing.T) {
	base := plainDir(t)
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	cfg.TrashDir = filepath.Join(base, "trash")
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	h = asRole(h, true)
	q := "?root=" + url.QueryEscape(root)
	body := `{"trashId":"` + randomHex(16) + `","trashIds":["` + randomHex(16) + `"]}`
	for _, route := range []string{"trash/delete", "trash/empty"} {
		path := "/api/mux/panes/0/files/" + route
		cross := apiRequest("POST", path+q, body)
		cross.Header.Set("Sec-Fetch-Site", "cross-site")
		cross.Header.Set("Origin", "https://evil.example")
		form := apiRequest("POST", path+q, body)
		form.Header.Set("Content-Type", "text/plain")
		for name, c := range map[string]struct {
			req  *http.Request
			want int
		}{
			"cross-site":   {cross, http.StatusForbidden},
			"content type": {form, http.StatusUnsupportedMediaType},
			"no root":      {apiRequest("POST", path, body), http.StatusBadRequest},
			"get":          {apiRequest("GET", path+q, ""), http.StatusMethodNotAllowed},
			"bad json":     {apiRequest("POST", path+q, "{"), http.StatusBadRequest},
			"root moved":   {apiRequest("POST", path+"?root=/elsewhere", body), http.StatusConflict},
			"view only":    {viewRequest("POST", path+q, body), http.StatusForbidden},
		} {
			if rec := serve(h, c.req); rec.Code != c.want {
				t.Errorf("%s %s = %d %s", route, name, rec.Code, rec.Body)
			}
		}
	}
	if rec := serve(h, viewRequest("GET", "/api/mux/panes/0/files/trash"+q, "")); rec.Code != http.StatusForbidden {
		t.Errorf("view list = %d", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/trash"+q, "")); rec.Code != 200 {
		t.Errorf("list = %d %s", rec.Code, rec.Body)
	}
}

func TestTrashListPlace(t *testing.T) {
	fx := newPlaceFixture(t, nil)
	q := fx.q("root", fx.place)
	code, del := fx.post(t, "POST", "delete", q, map[string]any{"path": "todo.md", "kind": "file", "baseHash": diskHash(t, filepath.Join(fx.place, "todo.md"))})
	if code != 200 {
		t.Fatalf("delete = %d %v", code, del)
	}
	code, list := fx.get(t, "trash", q)
	if code != 200 || !strings.Contains(list, del["trashId"].(string)) || !strings.Contains(list, `"path":"todo.md"`) {
		t.Errorf("place list = %d %s", code, list)
	}
	// The pane's root holds none of the Place's entries.
	if code, list := fx.get(t, "trash", url.Values{"root": {fx.pane}}); code != 200 || strings.Contains(list, "todo.md") {
		t.Errorf("pane list = %d %s", code, list)
	}
	if code, body := fx.post(t, "POST", "trash/delete", url.Values{"root": {fx.pane}}, map[string]any{"trashId": del["trashId"]}); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("pane delete = %d %v", code, body)
	}
	if code, body := fx.post(t, "POST", "trash/delete", q, map[string]any{"trashId": del["trashId"]}); code != 200 {
		t.Errorf("place delete = %d %v", code, body)
	}
}

// A delete between a restore's first read of the record and its second,
// under the lock: the restore is told the entry is gone, and nothing is
// restored.
func TestTrashDeleteBeforeRestoreLocks(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	_, body := fx.deleteOK(t, "a.txt")
	id := body["trashId"].(string)
	var purged error
	setFindHook(t, &restoreBeforeLock, func() { purged = fx.trash().purge(fx.root, id) })
	if code, body := fx.restore(t, id, false); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("restore = %d %v", code, body)
	}
	if purged != nil {
		t.Errorf("purge = %v", purged)
	}
	notExist(t, filepath.Join(fx.root, "a.txt"))
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash = %v", names)
	}
}

// A restore and a delete of the same entry at once: exactly one wins, the
// other is told it is not in the trash.
func TestTrashDeleteRacesRestore(t *testing.T) {
	for range 20 {
		fx := newTrashFixture(t)
		fx.write(t, "a.txt", "a\n")
		_, body := fx.deleteOK(t, "a.txt")
		id := body["trashId"].(string)
		var wg sync.WaitGroup
		var restoreErr, purgeErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, restoreErr = fx.f.restoreFile(filesRoot{Root: fx.root}, restoreRequest{TrashID: id})
		}()
		go func() {
			defer wg.Done()
			purgeErr = fx.trash().purge(fx.root, id)
		}()
		wg.Wait()
		_, statErr := os.Stat(filepath.Join(fx.root, "a.txt"))
		switch {
		case restoreErr == nil && errors.Is(purgeErr, errNotInTrash) && statErr == nil:
		case purgeErr == nil && errors.Is(restoreErr, errNotInTrash) && statErr != nil:
		default:
			t.Fatalf("restore %v, delete %v, file %v", restoreErr, purgeErr, statErr)
		}
		if names := fx.trashNames(t); len(names) != 0 {
			t.Fatalf("trash = %v", names)
		}
	}
}

func TestTrashDeletePayloadUnknown(t *testing.T) {
	fx := newTrashFixture(t)
	id := fx.putEntry(t, fx.root, "a.txt", "file", time.Now())
	setFindHook(t, &trashPayloadStat, func(*os.Root, string) (fs.FileInfo, error) { return nil, os.ErrPermission })
	if code, body := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 500 || body["error"] != "files request failed" {
		t.Errorf("delete = %d %v", code, body)
	}
	if !fx.trashHas(id) || !fx.trashHas(id+".json") {
		t.Error("the record went while the payload could not be looked at")
	}
}

// The store's directory can be searched but not opened: the record reads,
// the store's root does not, and the entry stays.
func TestTrashDeleteStoreUnopenable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs Unix permissions and a user other than root")
	}
	fx := newTrashFixture(t)
	id := fx.putEntry(t, fx.root, "a.txt", "file", time.Now())
	if err := os.Chmod(fx.trashDir, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(fx.trashDir, 0o700) })
	if code, body := fx.post(t, "trash/delete", map[string]any{"trashId": id}); code != 503 || body["code"] != "trash_unavailable" {
		t.Errorf("delete = %d %v", code, body)
	}
	if code, body := fx.get(t, "trash", fx.listQuery()); code != 503 || body["code"] != "trash_unavailable" {
		t.Errorf("list = %d %v", code, body)
	}
	os.Chmod(fx.trashDir, 0o700)
	if !fx.trashHas(id) || !fx.trashHas(id+".json") {
		t.Error("the entry went")
	}
}
