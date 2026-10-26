package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	templatesFile = "templates.json"
	templatesLock = "templates.lock"
	// templatesFormat is the file's v. A file with a higher one was written
	// by a newer Termote: it is read, never written (a rollback of `termote
	// update` keeps the newer one's templates).
	templatesFormat = 1
	maxTemplates    = 100
	// maxTemplateName is in runes, maxTemplateText in bytes: the Chat
	// composer's MAX_MESSAGE_BYTES, so an inserted template can be sent.
	maxTemplateName = 64
	maxTemplateText = 16 << 10
	// maxTemplatesRead bounds the file as read, well above 100 templates
	// written by this or a newer version.
	maxTemplatesRead = 16 << 20
	// templateBody fits one template of the largest size whose every byte
	// JSON escapes to two (`"`, `\`, newline, tab), plus its name;
	// templateImportBody fits 100 of them.
	templateBody       = 40 << 10
	templateImportBody = maxTemplates * templateBody
)

// templatesLockWait bounds the wait for another process's write; a
// variable so tests can shorten it.
var templatesLockWait = 2 * time.Second

var templatePartRe = regexp.MustCompile(`^\.templates-[0-9a-f]{16}\.part$`)

var (
	errTemplatesUnavailable = &codedError{"templates_unavailable", "prompt templates are not available on this server", http.StatusServiceUnavailable}
	errTemplatesNewer       = &codedError{"newer_format", "the templates were saved by a newer Termote: update it to change them", http.StatusConflict}
	errTemplatesBusy        = &codedError{"busy", "another process is changing the templates: try again", http.StatusServiceUnavailable}
	errTemplateNotFound     = &codedError{"not_found", "no such template", http.StatusNotFound}
	errTemplateNameTaken    = &codedError{"name_taken", "a template with this name exists", http.StatusConflict}
	errTooManyTemplates     = &codedError{"too_many", fmt.Sprintf("up to %d templates", maxTemplates), http.StatusConflict}
	errImportChanged        = &codedError{"import_changed", "the templates changed since the preview", http.StatusConflict}
	errTemplatesTooLarge    = &codedError{"too_large", "request body too large", http.StatusRequestEntityTooLarge}
)

// templateConflict is a PUT or DELETE whose updated is not the template's
// any more: another device changed it. It carries the current one.
type templateConflict struct {
	codedError
	template promptTemplate
}

// templateInputError names what is wrong with a template: field is "name"
// or "text" (empty for a duplicate), index its place in an import (-1
// outside one).
type templateInputError struct {
	codedError
	index int
	field string
}

func invalidTemplate(field, msg string) *templateInputError {
	return &templateInputError{codedError{"invalid_template", msg, http.StatusBadRequest}, -1, field}
}

// promptTemplate is one saved prompt. updated changes with every write of
// it, so a PUT or DELETE from a device that read an older one is refused.
type promptTemplate struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Text    string    `json:"text"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

// templateInput is a template as a client sends it.
type templateInput struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type templateFile struct {
	V         int              `json:"v"`
	Templates []promptTemplate `json:"templates"`
}

// templateStore keeps the prompt templates in <stateDir>/templates. They
// are what the user typed and cannot be made again: a file that cannot be
// read is an error, never overwritten or renamed. Every write holds
// templates.lock and reads the file again first, so a second process on
// the same state dir (a second serve, the old service during an update)
// never writes back what it read before another's write.
type templateStore struct {
	dir string
	now func() time.Time

	// writeMu orders this process's writes; templates.lock is taken after
	// it and before mu, so a read never waits behind another process.
	writeMu sync.Mutex
	mu      sync.Mutex
	list    []promptTemplate
	// readOnly: the file is a newer version's
	readOnly bool
	modTime  time.Time
	size     int64
	// badTime, badSize: the file as it was when it could not be read again,
	// so a corrupt file is not read and logged on every request
	badTime time.Time
	badSize int64
}

func newTemplateStore(dir string) (*templateStore, error) {
	if dir == "" {
		return nil, errors.New("no templates state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// Lstat: a symlink to a dir is refused too.
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &templateStore{dir: dir, now: time.Now}
	removeStateParts(dir, templatePartRe)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *templateStore) path() string { return filepath.Join(s.dir, templatesFile) }

// readLocked reads templates.json as it is on disk; a missing file is
// empty. The limits are not checked again: a newer version may allow more.
func (s *templateStore) readLocked() (templateFile, os.FileInfo, error) {
	fi, err := os.Lstat(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return templateFile{V: templatesFormat}, nil, nil
	}
	if err != nil {
		return templateFile{}, nil, fmt.Errorf("read %s: %w", templatesFile, err)
	}
	if fi.Size() > maxTemplatesRead {
		return templateFile{}, nil, fmt.Errorf("%s is larger than %d bytes", templatesFile, maxTemplatesRead)
	}
	data, err := readStateFile(s.path())
	if err != nil {
		return templateFile{}, nil, fmt.Errorf("read %s: %w", templatesFile, err)
	}
	var f templateFile
	if err := json.Unmarshal(data, &f); err != nil {
		return templateFile{}, nil, fmt.Errorf("%s is corrupt: %w", templatesFile, err)
	}
	if f.V < 1 {
		return templateFile{}, nil, fmt.Errorf("%s is corrupt: no format version", templatesFile)
	}
	return f, fi, nil
}

// reloadLocked makes the file's templates the store's. On failure what is
// in memory stays.
func (s *templateStore) reloadLocked() error {
	f, fi, err := s.readLocked()
	if err != nil {
		return err
	}
	s.list = f.Templates
	s.readOnly = f.V > templatesFormat
	s.modTime, s.size = time.Time{}, 0
	if fi != nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// maybeReloadLocked reads the file again when its time or size changed
// since it was read: another process wrote it. A file that cannot be read
// keeps what is in memory.
func (s *templateStore) maybeReloadLocked() {
	fi, err := os.Lstat(s.path())
	switch {
	case errors.Is(err, os.ErrNotExist):
		if s.size == 0 && s.modTime.IsZero() {
			return
		}
	case err != nil:
		return
	case fi.ModTime().Equal(s.modTime) && fi.Size() == s.size,
		fi.ModTime().Equal(s.badTime) && fi.Size() == s.badSize:
		return
	}
	if err := s.reloadLocked(); err != nil {
		log.Printf("templates: %v", err)
		if fi != nil {
			s.badTime, s.badSize = fi.ModTime(), fi.Size()
		}
	}
}

// templates returns the templates by name, and whether a newer version's
// file makes them read-only.
func (s *templateStore) templates() ([]promptTemplate, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	return sortedTemplates(s.list), s.readOnly
}

func sortedTemplates(list []promptTemplate) []promptTemplate {
	out := slices.Clone(list)
	if out == nil {
		out = []promptTemplate{}
	}
	slices.SortStableFunc(out, func(a, b promptTemplate) int {
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out
}

// change runs op on the templates as the file holds them now, under
// templates.lock, and writes the result. On any failure nothing changes, in
// memory or on disk.
func (s *templateStore) change(op func([]promptTemplate) ([]promptTemplate, error)) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	unlock, err := lockStateFile(filepath.Join(s.dir, templatesLock), templatesLockWait)
	if errors.Is(err, errStateLockTimeout) {
		log.Printf("templates: %s still locked after %s", templatesLock, templatesLockWait)
		return errTemplatesBusy
	}
	if err != nil {
		return fmt.Errorf("lock %s: %w", templatesFile, err)
	}
	defer unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	if s.readOnly {
		return errTemplatesNewer
	}
	next, err := op(slices.Clone(s.list))
	if err != nil {
		return err
	}
	data, err := json.Marshal(templateFile{V: templatesFormat, Templates: next})
	if err != nil {
		return err
	}
	if err := writeStateFile("templates", s.dir, "templates", s.path(), data, false); err != nil {
		return fmt.Errorf("write %s: %w", templatesFile, err)
	}
	s.list = next
	s.modTime, s.size = time.Time{}, 0
	if fi, err := os.Lstat(s.path()); err == nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// stamp is a write's time, after prev: a clock that did not move still
// changes updated, which PUT and DELETE compare.
func (s *templateStore) stamp(prev time.Time) time.Time {
	t := s.now().UTC().Round(0)
	if !t.After(prev) {
		t = prev.Add(time.Nanosecond)
	}
	return t
}

func newTemplateID() string {
	var b [8]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// validTemplateID: ids are 16 hex digits, so a path never names a file.
func validTemplateID(id string) bool {
	if len(id) != 16 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && strings.ToLower(id) == id
}

// findName returns the index of the template named name (EqualFold), other
// than skip, or -1.
func findName(list []promptTemplate, name, skip string) int {
	return slices.IndexFunc(list, func(t promptTemplate) bool {
		return t.ID != skip && strings.EqualFold(t.Name, name)
	})
}

func (s *templateStore) create(in templateInput) (promptTemplate, error) {
	name, text, err := validateTemplate(in.Name, in.Text)
	if err != nil {
		return promptTemplate{}, err
	}
	var made promptTemplate
	err = s.change(func(list []promptTemplate) ([]promptTemplate, error) {
		if findName(list, name, "") >= 0 {
			return nil, errTemplateNameTaken
		}
		if len(list) >= maxTemplates {
			return nil, errTooManyTemplates
		}
		now := s.stamp(time.Time{})
		made = promptTemplate{ID: newTemplateID(), Name: name, Text: text, Created: now, Updated: now}
		return append(list, made), nil
	})
	return made, err
}

// current finds id, refusing a stale updated with the template as it is.
func current(list []promptTemplate, id, updated string) (int, error) {
	i := slices.IndexFunc(list, func(t promptTemplate) bool { return t.ID == id })
	if i < 0 {
		return -1, errTemplateNotFound
	}
	if list[i].Updated.Format(time.RFC3339Nano) != updated {
		return -1, &templateConflict{codedError{"conflict", "the template was changed on another device", http.StatusConflict}, list[i]}
	}
	return i, nil
}

func (s *templateStore) update(id string, in templateInput, updated string) (promptTemplate, error) {
	name, text, err := validateTemplate(in.Name, in.Text)
	if err != nil {
		return promptTemplate{}, err
	}
	var saved promptTemplate
	err = s.change(func(list []promptTemplate) ([]promptTemplate, error) {
		i, err := current(list, id, updated)
		if err != nil {
			return nil, err
		}
		if findName(list, name, id) >= 0 {
			return nil, errTemplateNameTaken
		}
		list[i].Name, list[i].Text, list[i].Updated = name, text, s.stamp(list[i].Updated)
		saved = list[i]
		return list, nil
	})
	return saved, err
}

func (s *templateStore) remove(id, updated string) error {
	return s.change(func(list []promptTemplate) ([]promptTemplate, error) {
		i, err := current(list, id, updated)
		if err != nil {
			return nil, err
		}
		return slices.Delete(list, i, i+1), nil
	})
}

// importPlan applies an import to list: a name already there (EqualFold)
// is replaced, keeping its id, any other added. added and replaced are the
// names as imported.
func (s *templateStore) importPlan(list []promptTemplate, items []templateInput) (next []promptTemplate, added, replaced []string, err error) {
	clean := make([]templateInput, len(items))
	for i, in := range items {
		name, text, err := validateTemplate(in.Name, in.Text)
		if err != nil {
			var ie *templateInputError
			if errors.As(err, &ie) {
				ie.index = i
			}
			return nil, nil, nil, err
		}
		for j := range i {
			if strings.EqualFold(clean[j].Name, name) {
				return nil, nil, nil, &templateInputError{codedError{"duplicate_name", "two templates in the import have the same name", http.StatusBadRequest}, i, "name"}
			}
		}
		clean[i] = templateInput{name, text}
	}
	added, replaced = []string{}, []string{}
	for _, in := range clean {
		if i := findName(list, in.Name, ""); i >= 0 {
			list[i].Name, list[i].Text, list[i].Updated = in.Name, in.Text, s.stamp(list[i].Updated)
			replaced = append(replaced, in.Name)
			continue
		}
		now := s.stamp(time.Time{})
		list = append(list, promptTemplate{ID: newTemplateID(), Name: in.Name, Text: in.Text, Created: now, Updated: now})
		added = append(added, in.Name)
	}
	if len(list) > maxTemplates {
		return nil, nil, nil, errTooManyTemplates
	}
	return list, added, replaced, nil
}

// preview tells what an import would add and replace, writing nothing.
func (s *templateStore) preview(items []templateInput) (added, replaced []string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	if s.readOnly {
		return nil, nil, errTemplatesNewer
	}
	_, added, replaced, err = s.importPlan(slices.Clone(s.list), items)
	return added, replaced, err
}

// importAll applies an import as one write, or nothing. replace is what
// the preview said it would replace: when the templates changed since, so
// that it would replace others, it is refused.
func (s *templateStore) importAll(items []templateInput, replace []string) (added, replaced int, err error) {
	err = s.change(func(list []promptTemplate) ([]promptTemplate, error) {
		next, a, r, err := s.importPlan(list, items)
		if err != nil {
			return nil, err
		}
		if !sameNames(r, replace) {
			return nil, errImportChanged
		}
		added, replaced = len(a), len(r)
		return next, nil
	})
	return added, replaced, err
}

// sameNames: a and b name the same templates, by EqualFold. a is an
// import's replaced names, which never repeat.
func sameNames(a, b []string) bool {
	in := func(x string, list []string) bool {
		return slices.ContainsFunc(list, func(y string) bool { return strings.EqualFold(x, y) })
	}
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		if !in(x, b) {
			return false
		}
	}
	for _, y := range b {
		if !in(y, a) {
			return false
		}
	}
	return true
}

// validateTemplate returns the name trimmed and the text with its line
// breaks made \n, or why they cannot be saved. Both refuse control
// characters (the text keeps tab and newline) and characters that show
// nothing: a shared template must not carry an instruction the reader
// cannot see.
func validateTemplate(name, text string) (string, string, error) {
	name = strings.TrimSpace(name)
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	switch n := utf8.RuneCountInString(name); {
	case !utf8.ValidString(name):
		return "", "", invalidTemplate("name", "the name is not valid UTF-8")
	case n == 0:
		return "", "", invalidTemplate("name", "the name is empty")
	case n > maxTemplateName:
		return "", "", invalidTemplate("name", fmt.Sprintf("the name is longer than %d characters", maxTemplateName))
	}
	switch {
	case !utf8.ValidString(text):
		return "", "", invalidTemplate("text", "the text is not valid UTF-8")
	case text == "":
		return "", "", invalidTemplate("text", "the text is empty")
	case len(text) > maxTemplateText:
		return "", "", invalidTemplate("text", fmt.Sprintf("the text is larger than %d bytes", maxTemplateText))
	}
	if strings.ContainsFunc(name, func(r rune) bool { return unicode.IsControl(r) || hiddenRune(r) }) {
		return "", "", invalidTemplate("name", "the name contains control or hidden characters")
	}
	if strings.ContainsFunc(text, func(r rune) bool {
		return (unicode.IsControl(r) && r != '\n' && r != '\t') || hiddenRune(r)
	}) {
		return "", "", invalidTemplate("text", "the text contains control or hidden characters")
	}
	return name, text, nil
}

// hiddenRune reports a character that changes or hides text without
// showing: format characters (bidi controls, zero width space, word
// joiner, BOM) except the joiners emoji and some scripts need, tag
// characters and the variation selectors supplement. The basic variation
// selectors stay, for emoji.
func hiddenRune(r rune) bool {
	switch {
	case r == '\u200c' || r == '\u200d':
		return false
	case r >= 0xE0000 && r <= 0xE007F, r >= 0xE0100 && r <= 0xE01EF:
		return true
	}
	return unicode.Is(unicode.Cf, r)
}
