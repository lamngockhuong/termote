package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
)

// Writing herdr-app's layout document (hc). herdr-app keeps a machine's
// spaces and tabs in the core's "herdr-app" document, and its window follows
// every write. termote changes only what the PWA can: a space's or a tab's
// name, and the order of the spaces and of a space's tabs. The document is
// edited as generic JSON, so every field termote does not know (looks,
// sizes, floating blocks) is written back as it was read, and each write
// goes over the version it was read at: a write herdr-app beat is read and
// made again.

var (
	// errHcNoLayout: herdr-app has not written this machine's layout (it
	// never ran here), or wrote one termote does not understand.
	errHcNoLayout = &codedError{"no_layout", "herdr-app has no layout for this machine; open herdr-app", http.StatusConflict}
	// errHcDocBusy: herdr-app kept changing the layout while termote wrote.
	errHcDocBusy = &codedError{"layout_busy", "herdr-app changed the layout meanwhile; try again", http.StatusServiceUnavailable}
	// errHcDocSame: the edit changes nothing, so nothing is written.
	errHcDocSame = errors.New("hc document unchanged")
)

// hcDocWriteTries bounds the read-change-write rounds a conflict repeats.
const hcDocWriteTries = 3

// hasDoc: herdr-app's document is read and understood, so names and order
// can be written.
func (s *hcState) hasDoc() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.doc != nil
}

// editDoc reads the document, lets edit change it, and writes it over the
// version read. The state takes the written document at once, so the next
// snapshot shows the change.
func (m *hcMux) editDoc(ctx context.Context, edit func(doc map[string]any) error) error {
	conn, err := m.conn(ctx)
	if err != nil {
		return err
	}
	for range hcDocWriteTries {
		var cur struct {
			Value   json.RawMessage `json:"value"`
			Version uint64          `json:"version"`
		}
		if err := conn.call(ctx, hcDocGetParams{}, &cur); err != nil {
			return hcError(err)
		}
		// The same limits as a read: one past them is not herdr-app's.
		if d, err := parseHcDoc(cur.Value); err != nil || d == nil || cur.Version == 0 {
			if err != nil {
				log.Printf("hc: herdr-app document version %d not understood, not written: %v", cur.Version, err)
			}
			return errHcNoLayout
		}
		// It parsed as an object above, so it decodes. Numbers go back as
		// they were read.
		dec := json.NewDecoder(bytes.NewReader(cur.Value))
		dec.UseNumber()
		var doc map[string]any
		_ = dec.Decode(&doc)
		if err := edit(doc); err != nil {
			if errors.Is(err, errHcDocSame) {
				return nil
			}
			return err
		}
		// Keys come back sorted and <, >, & escaped: the same JSON value. It
		// holds only what the decoder made, so it encodes.
		value, _ := json.Marshal(doc)
		var set struct {
			Version uint64 `json:"version"`
		}
		err := conn.call(ctx, hcDocSetParams{Version: cur.Version, Value: value}, &set)
		if hcErrorKind(err) == "conflict" {
			continue
		}
		if err != nil {
			return hcError(err)
		}
		if parsed, err := parseHcDoc(value); err == nil && set.Version > 0 {
			m.state.setDoc(set.Version, parsed, false)
			m.bump()
		}
		return nil
	}
	return errHcDocBusy
}

// hcDocList is a JSON array of objects under key, the objects it holds only.
func hcDocList(obj map[string]any, key string) []any {
	list, _ := obj[key].([]any)
	return list
}

// hcDocID is an object's "id".
func hcDocID(v any) string {
	o, _ := v.(map[string]any)
	id, _ := o["id"].(string)
	return id
}

// hcDocFind is the object of list whose id is id.
func hcDocFind(list []any, id string) map[string]any {
	for _, v := range list {
		if hcDocID(v) == id {
			o, _ := v.(map[string]any)
			return o
		}
	}
	return nil
}

// hcDocTabSpace is the space holding tab id and that tab.
func hcDocTabSpace(doc map[string]any, id string) (space, tab map[string]any) {
	for _, s := range hcDocList(doc, "spaces") {
		so, _ := s.(map[string]any) // an object: the document parsed
		if t := hcDocFind(hcDocList(so, "tabs"), id); t != nil {
			return so, t
		}
	}
	return nil, nil
}

// validHcName accepts a space or tab name: what the group routes accept
// (validateTmuxTarget), without a control or format character.
func validHcName(name string) bool {
	return validateTmuxTarget(name) && !strings.ContainsFunc(name, hcUnsafeRune)
}

// setHcDocName sets o's name, errHcDocSame when it already is name.
func setHcDocName(o map[string]any, name string) error {
	if cur, _ := o["name"].(string); cur == name {
		return errHcDocSame
	}
	o["name"] = name
	return nil
}

// RenameTab names a tab of herdr-app's document. A tab termote placed by its
// labels (herdr-app has not taken it in yet) is not in it: unknown.
func (m *hcMux) RenameTab(ctx context.Context, tabID, name, key string) error {
	if key != "" && key != tabID {
		return errTabChanged
	}
	if !validHcName(name) {
		return inputError("invalid tab name")
	}
	return m.editDoc(ctx, func(doc map[string]any) error {
		_, tab := hcDocTabSpace(doc, tabID)
		if tab == nil {
			return errUnknownTab
		}
		return setHcDocName(tab, name)
	})
}

// RenameGroup names a space of herdr-app's document.
func (m *hcMux) RenameGroup(ctx context.Context, groupID, name string) error {
	if !validHcName(name) {
		return errInvalidGroupName
	}
	return m.editDoc(ctx, func(doc map[string]any) error {
		space := hcDocFind(hcDocList(doc, "spaces"), groupID)
		if space == nil {
			return errUnknownGroup
		}
		return setHcDocName(space, name)
	})
}

// hcMoved is ids with the one at from moved to index.
func hcMoved(ids []string, from, index int) []string {
	out := slices.Delete(slices.Clone(ids), from, from+1)
	return slices.Insert(out, index, ids[from])
}

// hcDocUnique reports whether every object of list has its own id: herdr-app
// writes no other, and a move could not tell two of one id apart.
func hcDocUnique(list []any) bool {
	seen := map[string]bool{}
	for _, v := range list {
		id := hcDocID(v)
		if id == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

// moveInHcDoc moves id among the objects of list the snapshot shows (shown),
// as the document orders them now, to index; the others (a tab without a
// terminal) stay where they are. The snapshot lists what is placed by labels
// alone after the document's, so an index among those lands last among the
// document's. It is the reordered list, errHcDocSame when nothing moves.
func moveInHcDoc(list []any, shown []string, id string, index int, unknown error) ([]any, error) {
	if !hcDocUnique(list) {
		return nil, errHcNoLayout
	}
	var ids []string
	for _, v := range list {
		if slices.Contains(shown, hcDocID(v)) {
			ids = append(ids, hcDocID(v))
		}
	}
	src := slices.Index(ids, id)
	if src < 0 {
		return nil, unknown
	}
	dst := min(index, len(ids)-1)
	if dst == src {
		return nil, errHcDocSame
	}
	order := hcMoved(ids, src, dst)
	out := slices.Clone(list)
	next := 0
	for i, v := range list {
		if slices.Contains(ids, hcDocID(v)) {
			out[i] = hcDocFind(list, order[next])
			next++
		}
	}
	return out, nil
}

// MoveTab moves a tab among its space's tabs. The snapshot gives which tabs
// show and checks the index; the order moved is the document's as read for
// the write, so a move herdr-app made meanwhile is kept. The id never changes.
func (m *hcMux) MoveTab(ctx context.Context, tabID string, index int) (string, error) {
	snap, err := m.snapshot(ctx, false)
	if err != nil {
		return "", err
	}
	var shown []string
	for _, g := range snap.Groups {
		if slices.ContainsFunc(g.Tabs, func(t Tab) bool { return t.ID == tabID }) {
			for _, t := range g.Tabs {
				shown = append(shown, t.ID)
			}
		}
	}
	switch {
	case len(shown) == 0:
		return "", errUnknownTab
	case index >= len(shown):
		return "", errInvalidIndex
	}
	err = m.editDoc(ctx, func(doc map[string]any) error {
		space, _ := hcDocTabSpace(doc, tabID)
		if space == nil {
			return errUnknownTab
		}
		tabs, err := moveInHcDoc(hcDocList(space, "tabs"), shown, tabID, index, errUnknownTab)
		if err != nil {
			return err
		}
		space["tabs"] = tabs
		return nil
	})
	if err != nil {
		return "", err
	}
	return tabID, nil
}

// MoveGroup moves a space among the spaces, as MoveTab moves a tab.
func (m *hcMux) MoveGroup(ctx context.Context, groupID string, index int) error {
	snap, err := m.snapshot(ctx, false)
	if err != nil {
		return err
	}
	shown := make([]string, 0, len(snap.Groups))
	for _, g := range snap.Groups {
		shown = append(shown, g.ID)
	}
	switch {
	case !slices.Contains(shown, groupID):
		return errUnknownGroup
	case index >= len(shown):
		return errInvalidIndex
	}
	return m.editDoc(ctx, func(doc map[string]any) error {
		spaces, err := moveInHcDoc(hcDocList(doc, "spaces"), shown, groupID, index, errUnknownGroup)
		if err != nil {
			return err
		}
		doc["spaces"] = spaces
		return nil
	})
}
