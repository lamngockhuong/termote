package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// templateHandler builds a server without sign-in whose templates live in
// dir ("" for none); a request carrying viewDeviceHeader acts as a
// view-only device.
func templateHandler(t *testing.T, dir string) http.Handler {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	cfg.TemplatesDir = dir
	h, hub, _, err := buildServer(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return asRole(h, true)
}

func templateJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// postTemplate creates a template and returns it as the server answered.
func postTemplate(t *testing.T, h http.Handler, name, text string) map[string]any {
	t.Helper()
	rec := serve(h, apiRequest("POST", "/api/mux/templates", templateJSON(t, templateInput{name, text})))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %q = %d %s", name, rec.Code, rec.Body)
	}
	return decodeBody(t, rec)["template"].(map[string]any)
}

func listTemplates(t *testing.T, h http.Handler) []any {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/templates", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)["templates"].([]any)
}

func TestTemplateRoutesCRUD(t *testing.T) {
	h := templateHandler(t, t.TempDir())
	rec := serve(h, apiRequest("GET", "/api/mux/templates", ""))
	body := decodeBody(t, rec)
	if rec.Code != http.StatusOK || body["readOnly"] != false || len(body["templates"].([]any)) != 0 {
		t.Fatalf("empty list = %d %v", rec.Code, body)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q", cc)
	}

	tpl := postTemplate(t, h, "Review", "Review {{file}}")
	id, updated := tpl["id"].(string), tpl["updated"].(string)
	if tpl["name"] != "Review" || tpl["text"] != "Review {{file}}" || len(id) != 16 {
		t.Fatalf("created %v", tpl)
	}

	put := func(updated, name string) *http.Request {
		return apiRequest("PUT", "/api/mux/templates/"+id, templateJSON(t, map[string]string{"name": name, "text": "t", "updated": updated}))
	}
	rec = serve(h, put(updated, "Renamed"))
	saved := decodeBody(t, rec)["template"].(map[string]any)
	if rec.Code != http.StatusOK || saved["name"] != "Renamed" || saved["updated"] == updated {
		t.Fatalf("update = %d %v", rec.Code, saved)
	}
	// A stale update is answered with the template as it is now.
	rec = serve(h, put(updated, "Mine"))
	body = decodeBody(t, rec)
	if rec.Code != http.StatusConflict || body["code"] != "conflict" || body["template"].(map[string]any)["name"] != "Renamed" {
		t.Fatalf("stale update = %d %v", rec.Code, body)
	}
	del := func(updated string) *http.Request {
		return apiRequest("DELETE", "/api/mux/templates/"+id+"?updated="+updated, "")
	}
	rec = serve(h, del(updated))
	if body := decodeBody(t, rec); rec.Code != http.StatusConflict || body["template"] == nil {
		t.Fatalf("stale delete = %d %v", rec.Code, body)
	}
	if rec := serve(h, del(saved["updated"].(string))); rec.Code != http.StatusOK || decodeBody(t, rec)["ok"] != true {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	if n := len(listTemplates(t, h)); n != 0 {
		t.Fatalf("%d left", n)
	}
	for _, req := range []*http.Request{del("x"), put("x", "n"), apiRequest("PUT", "/api/mux/templates/not-an-id", `{"name":"n","text":"t"}`)} {
		if rec := serve(h, req); rec.Code != http.StatusNotFound || decodeBody(t, rec)["code"] != "not_found" {
			t.Errorf("%s %s = %d %s", req.Method, req.URL, rec.Code, rec.Body)
		}
	}
}

// A template of the largest size whose every byte JSON escapes to two fits
// the body limit.
func TestTemplateRoutesLargestEscape(t *testing.T) {
	h := templateHandler(t, t.TempDir())
	name := strings.Repeat(`"`, maxTemplateName)
	for i, ch := range []string{`"`, `\`, "\n", "\t"} {
		postTemplate(t, h, fmt.Sprintf("%s%d", name[:maxTemplateName-1], i), strings.Repeat(ch, maxTemplateText))
	}
	items := []templateInput{}
	for i := range maxTemplates {
		items = append(items, templateInput{fmt.Sprintf("%03d%s", i, name[:maxTemplateName-3]), strings.Repeat(`"`, maxTemplateText)})
	}
	h = templateHandler(t, t.TempDir())
	rec := serve(h, apiRequest("POST", "/api/mux/templates/import", templateJSON(t, map[string]any{"templates": items, "replace": []string{}})))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["added"] != float64(maxTemplates) || body["replaced"] != float64(0) {
		t.Fatalf("import = %d %v", rec.Code, body)
	}
	if n := len(listTemplates(t, h)); n != maxTemplates {
		t.Fatalf("%d templates", n)
	}
}

func TestTemplateRoutesImport(t *testing.T) {
	h := templateHandler(t, t.TempDir())
	postTemplate(t, h, "Review", "old")
	items := []templateInput{{"review", "new"}, {"Fresh", "f"}}
	rec := serve(h, apiRequest("POST", "/api/mux/templates/import?dryRun=1", templateJSON(t, map[string]any{"templates": items})))
	body := decodeBody(t, rec)
	if rec.Code != http.StatusOK || fmt.Sprint(body["added"]) != "[Fresh]" || fmt.Sprint(body["replaced"]) != "[review]" {
		t.Fatalf("dry run = %d %v", rec.Code, body)
	}
	rec = serve(h, apiRequest("POST", "/api/mux/templates/import", templateJSON(t, map[string]any{"templates": items})))
	if rec.Code != http.StatusConflict || decodeBody(t, rec)["code"] != "import_changed" {
		t.Fatalf("import without replace = %d %s", rec.Code, rec.Body)
	}
	rec = serve(h, apiRequest("POST", "/api/mux/templates/import", templateJSON(t, map[string]any{"templates": items, "replace": body["replaced"]})))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["added"] != float64(1) || body["replaced"] != float64(1) {
		t.Fatalf("import = %d %v", rec.Code, body)
	}
	// An error names the template it is about.
	bad := []templateInput{{"ok", "x"}, {"bad", "zero\u200bwidth"}}
	rec = serve(h, apiRequest("POST", "/api/mux/templates/import?dryRun=1", templateJSON(t, map[string]any{"templates": bad})))
	if body := decodeBody(t, rec); rec.Code != 400 || body["code"] != "invalid_template" || body["index"] != float64(1) || body["field"] != "text" {
		t.Fatalf("invalid import = %d %v", rec.Code, body)
	}
}

func TestTemplateRoutesRejects(t *testing.T) {
	dir := t.TempDir()
	h := templateHandler(t, dir)
	tpl := postTemplate(t, h, "Taken", "x")
	itemPath := "/api/mux/templates/" + tpl["id"].(string)
	good := templateJSON(t, templateInput{"n", "t"})
	with := func(r *http.Request, header ...string) *http.Request {
		for i := 0; i < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return r
	}
	big := templateJSON(t, templateInput{"n", strings.Repeat("a", templateBody)})
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
		code   string
	}{
		{"not JSON", with(apiRequest("POST", "/api/mux/templates", good), "Content-Type", "text/plain"), 415, ""},
		{"cross-site write", with(apiRequest("POST", "/api/mux/templates", good), "Sec-Fetch-Site", "cross-site", "Origin", "https://evil.test"), 403, ""},
		{"cross-site delete", with(apiRequest("DELETE", itemPath+"?updated="+tpl["updated"].(string), ""), "Sec-Fetch-Site", "cross-site"), 403, ""},
		{"cross-site read", with(apiRequest("GET", "/api/mux/templates", ""), "Sec-Fetch-Site", "cross-site"), 403, ""},
		{"foreign origin read", with(apiRequest("GET", "/api/mux/templates", ""), "Origin", "https://evil.test"), 403, ""},
		{"too large", apiRequest("POST", "/api/mux/templates", big), 413, "too_large"},
		{"too large update", apiRequest("PUT", itemPath, big), 413, "too_large"},
		{"too large import", apiRequest("POST", "/api/mux/templates/import", `{"templates":[{"name":"`+strings.Repeat("a", templateImportBody)+`"}]}`), 413, "too_large"},
		{"bad JSON", apiRequest("POST", "/api/mux/templates", "{"), 400, ""},
		{"invalid name", apiRequest("POST", "/api/mux/templates", `{"name":" ","text":"t"}`), 400, "invalid_template"},
		{"name taken", apiRequest("POST", "/api/mux/templates", `{"name":"TAKEN","text":"t"}`), 409, "name_taken"},
		{"PATCH list", apiRequest("PATCH", "/api/mux/templates", good), 405, ""},
		{"POST item", apiRequest("POST", itemPath, good), 405, ""},
		{"PUT import", apiRequest("PUT", "/api/mux/templates/import", good), 405, ""},
		{"view create", viewRequest("POST", "/api/mux/templates", good), 403, "view_only"},
		{"view update", viewRequest("PUT", itemPath, good), 403, "view_only"},
		{"view delete", viewRequest("DELETE", itemPath+"?updated="+tpl["updated"].(string), ""), 403, "view_only"},
		{"view import", viewRequest("POST", "/api/mux/templates/import?dryRun=1", `{"templates":[]}`), 403, "view_only"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(h, tc.req)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body)
			}
			if tc.code != "" {
				if got := decodeBody(t, rec)["code"]; got != tc.code {
					t.Errorf("code = %v, want %s", got, tc.code)
				}
			}
			if tc.status == 405 && rec.Header().Get("Allow") == "" {
				t.Error("405 without Allow")
			}
		})
	}
	// A view-only device reads them.
	if rec := serve(h, viewRequest("GET", "/api/mux/templates", "")); rec.Code != http.StatusOK || len(decodeBody(t, rec)["templates"].([]any)) != 1 {
		t.Fatalf("view list = %d %s", rec.Code, rec.Body)
	}
	if list := listTemplates(t, h); len(list) != 1 || list[0].(map[string]any)["text"] != "x" {
		t.Fatalf("a refused request changed the templates: %v", list)
	}

	// A file that cannot be read fails the write without saying why.
	os.WriteFile(filepath.Join(dir, templatesFile), []byte("{corrupt and longer than the file was ............................................"), 0o600)
	rec := serve(h, apiRequest("POST", "/api/mux/templates", good))
	if b := rec.Body.String(); rec.Code != 500 || strings.Contains(b, dir) || strings.Contains(b, "corrupt") {
		t.Fatalf("failed save = %d %s", rec.Code, b)
	}
}

func TestTemplateRoutesNewerFormat(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, templatesFile), []byte(`{"v":2,"templates":[]}`), 0o600)
	h := templateHandler(t, dir)
	rec := serve(h, apiRequest("GET", "/api/mux/templates", ""))
	if decodeBody(t, rec)["readOnly"] != true {
		t.Fatalf("list = %s", rec.Body)
	}
	rec = serve(h, apiRequest("POST", "/api/mux/templates", `{"name":"n","text":"t"}`))
	if rec.Code != http.StatusConflict || decodeBody(t, rec)["code"] != "newer_format" {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
}

func TestTemplateRoutesCaps(t *testing.T) {
	h := templateHandler(t, t.TempDir())
	if snap := serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.String(); !strings.Contains(snap, `"templates":true`) {
		t.Errorf("snapshot caps: %s", snap)
	}
	// A file that cannot be read: the store is off, the file kept.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, templatesFile), []byte("{nope"), 0o600)
	for _, h := range []http.Handler{templateHandler(t, ""), templateHandler(t, dir)} {
		if snap := serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.String(); !strings.Contains(snap, `"templates":false`) {
			t.Errorf("snapshot caps: %s", snap)
		}
		for _, req := range []*http.Request{
			apiRequest("GET", "/api/mux/templates", ""),
			apiRequest("POST", "/api/mux/templates", `{"name":"n","text":"t"}`),
			apiRequest("PUT", "/api/mux/templates/0123456789abcdef", `{"name":"n","text":"t"}`),
			apiRequest("DELETE", "/api/mux/templates/0123456789abcdef", ""),
			apiRequest("POST", "/api/mux/templates/import", `{"templates":[]}`),
		} {
			rec := serve(h, req)
			if rec.Code != http.StatusServiceUnavailable || decodeBody(t, rec)["code"] != "templates_unavailable" {
				t.Errorf("%s %s = %d %s", req.Method, req.URL.Path, rec.Code, rec.Body)
			}
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dir, templatesFile)); string(got) != "{nope" {
		t.Errorf("file changed to %s", got)
	}
}

// The templates dir sits in the state dir, which the Files view never
// serves.
func TestTemplatesDirDeniedToFiles(t *testing.T) {
	home := t.TempDir()
	c := &cli{goos: "linux", home: home}
	cfg := testConfig(t)
	cfg.FilesDenyDirs = filesDenyDirs(c.configDir(), c.stateDir())
	cfg.TemplatesDir = filepath.Join(c.stateDir(), "templates")
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: home, files: true})
	if err != nil {
		t.Fatal(err)
	}
	postTemplate(t, h, "n", "t")
	rel, _ := filepath.Rel(home, filepath.Join(cfg.TemplatesDir, templatesFile))
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?path="+filepath.ToSlash(rel), ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("files/content served the templates: %d %s", rec.Code, rec.Body)
	}
}
