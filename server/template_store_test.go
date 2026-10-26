package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestTemplateStore(t *testing.T, dir string) *templateStore {
	t.Helper()
	s, err := newTemplateStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustCreate(t *testing.T, s *templateStore, name, text string) promptTemplate {
	t.Helper()
	tpl, err := s.create(templateInput{name, text})
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return tpl
}

func stamp(t promptTemplate) string { return t.Updated.Format(time.RFC3339Nano) }

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ce *codedError
	var conflict *templateConflict
	var input *templateInputError
	got := ""
	switch {
	case errors.As(err, &conflict):
		got = conflict.code
	case errors.As(err, &input):
		got = input.code
	case errors.As(err, &ce):
		got = ce.code
	}
	if got != code {
		t.Fatalf("err = %v (code %q), want %s", err, got, code)
	}
}

func names(list []promptTemplate) []string {
	out := []string{}
	for _, t := range list {
		out = append(out, t.Name)
	}
	return out
}

func TestTemplateStoreCRUD(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "templates")
	s := newTestTemplateStore(t, dir)
	if list, ro := s.templates(); len(list) != 0 || ro || list == nil {
		t.Fatalf("new store = %v %v", list, ro)
	}
	b := mustCreate(t, s, "  beta  ", "Review {{file}}\r\non {{branch}}")
	if b.Name != "beta" || b.Text != "Review {{file}}\non {{branch}}" || !validTemplateID(b.ID) {
		t.Fatalf("created = %+v", b)
	}
	mustCreate(t, s, "Alpha", "a")
	mustCreate(t, s, "gamma", "g")
	if got := names(s.list); strings.Join(got, ",") != "beta,Alpha,gamma" {
		t.Errorf("stored order = %v", got)
	}
	list, _ := s.templates()
	if got := strings.Join(names(list), ","); got != "Alpha,beta,gamma" {
		t.Errorf("templates() = %s, want by name", got)
	}

	b2, err := s.update(b.ID, templateInput{"Beta", "new"}, stamp(b))
	if err != nil || b2.Name != "Beta" || b2.Text != "new" || !b2.Updated.After(b.Updated) || !b2.Created.Equal(b.Created) {
		t.Fatalf("update = %+v %v", b2, err)
	}
	// The device that read b before the update is refused, with b2.
	_, err = s.update(b.ID, templateInput{"Beta", "mine"}, stamp(b))
	var conflict *templateConflict
	if !errors.As(err, &conflict) || conflict.template.Text != "new" {
		t.Fatalf("stale update = %v", err)
	}
	wantCode(t, s.remove(b.ID, stamp(b)), "conflict")
	if err := s.remove(b.ID, stamp(b2)); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.remove(b.ID, stamp(b2)), "not_found")
	_, err = s.update(b.ID, templateInput{"x", "y"}, stamp(b2))
	wantCode(t, err, "not_found")

	// A restart reads what was written, owner only.
	again := newTestTemplateStore(t, dir)
	if list, _ := again.templates(); strings.Join(names(list), ",") != "Alpha,gamma" {
		t.Errorf("after restart: %v", names(list))
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v %v", fi.Mode(), err)
		}
		if fi, err := os.Stat(filepath.Join(dir, templatesFile)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("file mode %v %v", fi.Mode(), err)
		}
	}
}

func TestTemplateStoreNames(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	a := mustCreate(t, s, "Code review", "x")
	_, err := s.create(templateInput{"CODE REVIEW", "y"})
	wantCode(t, err, "name_taken")
	_, err = s.create(templateInput{" code review ", "y"})
	wantCode(t, err, "name_taken")
	// Renaming to itself, in another case, is no clash.
	if _, err := s.update(a.ID, templateInput{"code Review", "x"}, stamp(a)); err != nil {
		t.Fatal(err)
	}
	b := mustCreate(t, s, "Other", "y")
	_, err = s.update(b.ID, templateInput{"code review", "y"}, stamp(b))
	wantCode(t, err, "name_taken")
}

func TestTemplateStoreLimit(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	for i := range maxTemplates {
		mustCreate(t, s, "t"+strconv.Itoa(i), "x")
	}
	_, err := s.create(templateInput{"one more", "x"})
	wantCode(t, err, "too_many")
	if len(s.list) != maxTemplates {
		t.Fatalf("%d templates", len(s.list))
	}
}

// A clock that does not move still changes updated, so a device holding
// the previous one is refused.
func TestTemplateStoreStampMoves(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	frozen := time.Date(2026, 10, 26, 1, 2, 3, 0, time.UTC)
	s.now = func() time.Time { return frozen }
	a := mustCreate(t, s, "a", "x")
	a2, err := s.update(a.ID, templateInput{"a", "y"}, stamp(a))
	if err != nil || stamp(a2) == stamp(a) {
		t.Fatalf("updated %s then %s (%v)", stamp(a), stamp(a2), err)
	}
	_, err = s.update(a.ID, templateInput{"a", "z"}, stamp(a))
	wantCode(t, err, "conflict")
}

func TestValidateTemplate(t *testing.T) {
	long := strings.Repeat("é", maxTemplateName)
	for _, tc := range []struct {
		name, text, field string
	}{
		{long, "x", ""},
		{long + "é", "x", "name"},
		{"   ", "x", "name"},
		{"", "x", "name"},
		{"a\xff", "x", "name"},
		{"a", "", "text"},
		{"a", "x\xff", "text"},
		{"a", strings.Repeat("a", maxTemplateText), ""},
		{"a", strings.Repeat("a", maxTemplateText+1), "text"},
		// \r\n counts as one byte once made \n.
		{"a", strings.Repeat("\r\n", maxTemplateText), ""},
		{"a", "lone \r is a newline", ""},
		{"a\tb", "x", "name"},
		{"a", "esc \x1b[31m", "text"},
	} {
		_, _, err := validateTemplate(tc.name, tc.text)
		var ie *templateInputError
		switch {
		case tc.field == "" && err != nil:
			t.Errorf("%.20q/%.20q: %v", tc.name, tc.text, err)
		case tc.field != "" && (!errors.As(err, &ie) || ie.field != tc.field || ie.code != "invalid_template" || ie.index != -1):
			t.Errorf("%.20q/%.20q: %v, want invalid %s", tc.name, tc.text, err, tc.field)
		}
	}
}

// The PWA's hiddenChars reads the same cases: it warns about what this
// refuses.
func TestValidateTemplateHiddenChars(t *testing.T) {
	data, err := os.ReadFile("testdata/template-hidden-chars.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			CodePoint      string
			InName, InText bool
			Why            string
		}
	}
	if err := json.Unmarshal(data, &f); err != nil || len(f.Cases) == 0 {
		t.Fatalf("cases: %v", err)
	}
	for _, c := range f.Cases {
		cp, err := strconv.ParseUint(c.CodePoint, 16, 32)
		if err != nil {
			t.Fatal(err)
		}
		s := "a" + string(rune(cp)) + "b"
		_, _, nameErr := validateTemplate(s, "x")
		_, _, textErr := validateTemplate("x", s)
		if (nameErr == nil) != c.InName || (textErr == nil) != c.InText {
			t.Errorf("U+%s (%s): name %v, text %v; want allowed %v, %v", c.CodePoint, c.Why, nameErr, textErr, c.InName, c.InText)
		}
	}
}

func TestTemplateStoreImport(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	keep := mustCreate(t, s, "Review", "old")
	items := []templateInput{{"review", "new"}, {"Fresh", "f"}}

	added, replaced, err := s.preview(items)
	if err != nil || fmt.Sprint(added) != "[Fresh]" || fmt.Sprint(replaced) != "[review]" {
		t.Fatalf("preview = %v %v %v", added, replaced, err)
	}
	if len(s.list) != 1 || s.list[0].Text != "old" {
		t.Fatal("the preview wrote")
	}
	// Not what the preview said: refused, nothing written.
	_, _, err = s.importAll(items, nil)
	wantCode(t, err, "import_changed")
	_, _, err = s.importAll(items, []string{"Review", "Fresh"})
	wantCode(t, err, "import_changed")
	if len(s.list) != 1 {
		t.Fatal("a refused import wrote")
	}
	a, r, err := s.importAll(items, []string{"REVIEW"})
	if err != nil || a != 1 || r != 1 {
		t.Fatalf("import = %d %d %v", a, r, err)
	}
	list, _ := s.templates()
	if fmt.Sprint(names(list)) != "[Fresh review]" || list[1].ID != keep.ID || list[1].Text != "new" || !list[1].Updated.After(keep.Updated) {
		t.Fatalf("after import: %+v", list)
	}
}

func TestTemplateStoreImportRefuses(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	mustCreate(t, s, "kept", "x")
	for _, tc := range []struct {
		name  string
		items []templateInput
		code  string
		index int
	}{
		{"invalid", []templateInput{{"ok", "x"}, {"bad", "\u202e"}}, "invalid_template", 1},
		{"duplicate", []templateInput{{"Same", "x"}, {"other", "y"}, {"same", "z"}}, "duplicate_name", 2},
	} {
		for _, dry := range []bool{true, false} {
			var err error
			if dry {
				_, _, err = s.preview(tc.items)
			} else {
				_, _, err = s.importAll(tc.items, nil)
			}
			var ie *templateInputError
			if !errors.As(err, &ie) || ie.code != tc.code || ie.index != tc.index {
				t.Errorf("%s (dry %v): %v", tc.name, dry, err)
			}
		}
	}
	many := []templateInput{}
	for i := range maxTemplates {
		many = append(many, templateInput{"m" + strconv.Itoa(i), "x"})
	}
	_, _, err := s.preview(many)
	wantCode(t, err, "too_many")
	_, _, err = s.importAll(many, nil)
	wantCode(t, err, "too_many")
	if list, _ := s.templates(); len(list) != 1 {
		t.Fatalf("a refused import wrote: %d", len(list))
	}
}

// 100 templates of the largest size round-trip through an import.
func TestTemplateStoreImportLargest(t *testing.T) {
	s := newTestTemplateStore(t, t.TempDir())
	items := []templateInput{}
	for i := range maxTemplates {
		name := fmt.Sprintf("%03d", i) + strings.Repeat("n", maxTemplateName-3)
		items = append(items, templateInput{name, strings.Repeat(`"`, maxTemplateText)})
	}
	if _, _, err := s.importAll(items, []string{}); err != nil {
		t.Fatal(err)
	}
	list, _ := newTestTemplateStore(t, s.dir).templates()
	if len(list) != maxTemplates || list[99].Name != items[99].Name || list[99].Text != items[99].Text {
		t.Fatalf("read back %d", len(list))
	}
}

func TestTemplateStoreLoad(t *testing.T) {
	write := func(t *testing.T, data string) string {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, templatesFile), []byte(data), 0o600)
		return dir
	}
	t.Run("corrupt is never overwritten", func(t *testing.T) {
		for _, data := range []string{"{nope", `{"templates":[]}`, `{"v":0}`, `[]`} {
			dir := write(t, data)
			if _, err := newTemplateStore(dir); err == nil {
				t.Errorf("%s loaded", data)
			}
			if got, _ := os.ReadFile(filepath.Join(dir, templatesFile)); string(got) != data {
				t.Errorf("file changed to %s", got)
			}
		}
	})
	t.Run("more than this version allows", func(t *testing.T) {
		var b strings.Builder
		b.WriteString(`{"v":1,"extra":true,"templates":[`)
		for i := range 150 {
			if i > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, `{"id":"%016x","name":"n%d","text":"x","color":"red"}`, i, i)
		}
		b.WriteString("]}")
		s := newTestTemplateStore(t, write(t, b.String()))
		if list, ro := s.templates(); len(list) != 150 || ro {
			t.Fatalf("%d templates, read-only %v", len(list), ro)
		}
	})
	t.Run("newer version is read-only", func(t *testing.T) {
		data := `{"v":2,"templates":[{"id":"0123456789abcdef","name":"n","text":"x","updated":"2026-10-26T00:00:00Z"}]}`
		dir := write(t, data)
		s := newTestTemplateStore(t, dir)
		list, ro := s.templates()
		if len(list) != 1 || !ro {
			t.Fatalf("%v %v", list, ro)
		}
		_, err := s.create(templateInput{"a", "b"})
		wantCode(t, err, "newer_format")
		wantCode(t, s.remove(list[0].ID, stamp(list[0])), "newer_format")
		_, _, err = s.preview([]templateInput{{"a", "b"}})
		wantCode(t, err, "newer_format")
		if got, _ := os.ReadFile(filepath.Join(dir, templatesFile)); string(got) != data {
			t.Errorf("file changed to %s", got)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need privileges")
		}
		dir, other := t.TempDir(), filepath.Join(t.TempDir(), "x.json")
		os.WriteFile(other, []byte(`{"v":1,"templates":[]}`), 0o600)
		os.Symlink(other, filepath.Join(dir, templatesFile))
		if _, err := newTemplateStore(dir); err == nil {
			t.Error("a symlinked file loaded")
		}
		link := filepath.Join(t.TempDir(), "link")
		os.Symlink(t.TempDir(), link)
		if _, err := newTemplateStore(link); err == nil {
			t.Error("a symlinked dir loaded")
		}
	})
	t.Run("too large", func(t *testing.T) {
		dir := t.TempDir()
		f, _ := os.Create(filepath.Join(dir, templatesFile))
		f.Truncate(maxTemplatesRead + 1)
		f.Close()
		if _, err := newTemplateStore(dir); err == nil {
			t.Error("an oversized file loaded")
		}
	})
	t.Run("no dir", func(t *testing.T) {
		if _, err := newTemplateStore(""); err == nil {
			t.Error("no dir loaded")
		}
		file := filepath.Join(t.TempDir(), "file")
		os.WriteFile(file, nil, 0o600)
		if _, err := newTemplateStore(file); err == nil {
			t.Error("a file as dir loaded")
		}
		if _, err := newTemplateStore(filepath.Join(file, "sub")); err == nil {
			t.Error("a dir under a file loaded")
		}
	})
	t.Run("stale parts are removed", func(t *testing.T) {
		dir := t.TempDir()
		part := filepath.Join(dir, ".templates-0123456789abcdef.part")
		other := filepath.Join(dir, ".other-0123456789abcdef.part")
		os.WriteFile(part, []byte("x"), 0o600)
		os.WriteFile(other, []byte("x"), 0o600)
		newTestTemplateStore(t, dir)
		if _, err := os.Stat(part); !errors.Is(err, os.ErrNotExist) {
			t.Error("part kept")
		}
		if _, err := os.Stat(other); err != nil {
			t.Error("another store's part removed")
		}
	})
}

// Two processes on one state dir: each write reads the other's first, and
// a read sees the other's write.
func TestTemplateStoreTwoProcesses(t *testing.T) {
	dir := t.TempDir()
	a, b := newTestTemplateStore(t, dir), newTestTemplateStore(t, dir)
	made := mustCreate(t, a, "from a", "x")
	if list, _ := b.templates(); len(list) != 1 {
		t.Fatalf("b reads %d", len(list))
	}
	if _, err := b.update(made.ID, templateInput{"edited by b", "y"}, stamp(made)); err != nil {
		t.Fatal(err)
	}
	mustCreate(t, a, "second from a", "z")
	list, _ := newTestTemplateStore(t, dir).templates()
	if fmt.Sprint(names(list)) != "[edited by b second from a]" {
		t.Fatalf("on disk: %v", names(list))
	}
	// A removed file reads as empty; a corrupt one keeps what was read.
	os.WriteFile(filepath.Join(dir, templatesFile), []byte("{nope, and longer than before ......................................."), 0o600)
	if list, _ := a.templates(); len(list) != 2 {
		t.Errorf("corrupt read: %d", len(list))
	}
	_, err := a.create(templateInput{"c", "x"})
	if err == nil || errors.As(err, new(*codedError)) {
		t.Errorf("write over a corrupt file: %v", err)
	}
	os.Remove(filepath.Join(dir, templatesFile))
	if list, _ := a.templates(); len(list) != 0 {
		t.Errorf("removed file: %d", len(list))
	}
}

func TestTemplateStoreLockTimeout(t *testing.T) {
	old := templatesLockWait
	templatesLockWait = 20 * time.Millisecond
	t.Cleanup(func() { templatesLockWait = old })
	dir := t.TempDir()
	s := newTestTemplateStore(t, dir)
	unlock, err := lockStateFile(filepath.Join(dir, templatesLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	_, err = s.create(templateInput{"a", "b"})
	wantCode(t, err, "busy")
}

// A failed write changes nothing.
func TestTemplateStoreWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Unix modes, not as root")
	}
	dir := t.TempDir()
	s := newTestTemplateStore(t, dir)
	mustCreate(t, s, "a", "x")
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := s.create(templateInput{"b", "y"}); err == nil {
		t.Fatal("wrote into a read-only dir")
	}
	if list, _ := s.templates(); len(list) != 1 {
		t.Fatalf("%d templates after a failed write", len(list))
	}
}

func TestTemplateSameNamesAndOrder(t *testing.T) {
	for _, tc := range []struct {
		a, b []string
		same bool
	}{
		{nil, []string{}, true},
		{[]string{"A", "b"}, []string{"B", "a"}, true},
		{[]string{"a"}, []string{"a", "a"}, false},
		{[]string{"a", "b"}, []string{"a", "a"}, false},
		{[]string{"a", "b"}, []string{"a", "c"}, false},
	} {
		if got := sameNames(tc.a, tc.b); got != tc.same {
			t.Errorf("sameNames(%v, %v) = %v", tc.a, tc.b, got)
		}
	}
	got := sortedTemplates([]promptTemplate{{Name: "b"}, {Name: "a"}, {Name: "A"}})
	if fmt.Sprint(names(got)) != "[A a b]" {
		t.Errorf("order = %v", names(got))
	}
	s := newTestTemplateStore(t, t.TempDir())
	a := mustCreate(t, s, "a", "x")
	_, err := s.update(a.ID, templateInput{"a", ""}, stamp(a))
	wantCode(t, err, "invalid_template")
}

// A read never waits for another process's lock, even behind a write of
// this process that does.
func TestTemplateStoreReadDoesNotWaitForLock(t *testing.T) {
	old := templatesLockWait
	templatesLockWait = time.Second
	t.Cleanup(func() { templatesLockWait = old })
	dir := t.TempDir()
	s := newTestTemplateStore(t, dir)
	unlock, err := lockStateFile(filepath.Join(dir, templatesLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.create(templateInput{"a", "b"})
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	s.templates()
	if took := time.Since(start); took > 200*time.Millisecond {
		t.Errorf("a read waited %s behind the lock", took)
	}
	unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// Two processes writing at once lose nothing.
func TestTemplateStoreConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	stores := []*templateStore{newTestTemplateStore(t, dir), newTestTemplateStore(t, dir)}
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := stores[i%2].create(templateInput{"t" + strconv.Itoa(i), "x"}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if list, _ := newTestTemplateStore(t, dir).templates(); len(list) != 40 {
		t.Fatalf("%d of 40 written", len(list))
	}
}
