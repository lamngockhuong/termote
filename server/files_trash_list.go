package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const (
	// trashListMax caps the entries files/trash lists, and the ids one
	// files/trash/empty takes.
	trashListMax = 500
	// trashEmptyBody fits trashListMax ids in a files/trash/empty body.
	trashEmptyBody = 24 << 10
)

var (
	errTrashListBusy = &codedError{"busy", "too many requests at once; try again", http.StatusTooManyRequests}
	errTrashIDs      = inputError("trashIds must hold 1 to 500 ids")
)

// trashPurge removes a payload from the trash, trashPayloadStat looks at
// one first; tests replace them to fail.
var (
	trashPurge       = func(trash *os.Root, name string) error { return trash.Remove(name) }
	trashPayloadStat = func(trash *os.Root, name string) (fs.FileInfo, error) { return trash.Lstat(name) }
)

// trashEntry is one entry of the trash as files/trash lists it.
type trashEntry struct {
	TrashID   string    `json:"trashId"`
	Path      string    `json:"path"` // '/'-separated, relative to the root
	Kind      string    `json:"kind"` // file | dir | discard
	DeletedAt time.Time `json:"deletedAt"`
	// ExpiresAt is when the sweep removes it at the latest: past the size
	// cap, sooner.
	ExpiresAt time.Time `json:"expiresAt"`
	Size      int64     `json:"size"`
	Sensitive bool      `json:"sensitive,omitempty"`
}

type trashListResponse struct {
	Root      string       `json:"root"`
	Entries   []trashEntry `json:"entries"`
	Truncated bool         `json:"truncated,omitempty"`
}

type trashDeleteRequest struct {
	TrashID string `json:"trashId"`
}

type trashDeleteResponse struct {
	Root    string `json:"root"`
	TrashID string `json:"trashId"`
}

type trashEmptyRequest struct {
	TrashIDs []string `json:"trashIds"`
}

type trashEmptyResponse struct {
	Root    string `json:"root"`
	Removed int    `json:"removed"`
	Failed  int    `json:"failed"`
}

// list returns the entries of the trash deleted under root, newest first, at
// most trashListMax (truncated when more). It holds no lock: a record is
// renamed into place whole and never changed, and one removed meanwhile is
// skipped. What the sweep would remove is left out, never removed here: an
// entry past maxAge, a file or discard without its payload, a file whose
// restore through link + unlink died in between.
func (s *trashStore) list(root string) ([]trashEntry, bool, error) {
	trash, err := s.open()
	if err != nil {
		return nil, false, err
	}
	defer trash.Close()
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, false, err
	}
	now := s.now()
	var out []trashEntry
	for _, e := range ents {
		name := e.Name()
		if !trashNameRe.MatchString(name) || filepath.Ext(name) != ".json" {
			continue
		}
		id := name[:32]
		// Through the store's root: on Windows a plain open shares no
		// delete, and a restore's or a sweep's removal of the record
		// meanwhile would fail unseen.
		fh, err := trash.Open(name)
		rec, err := decodeRecord(id, fh, err)
		if err != nil || rec.Root != root || now.Sub(rec.DeletedAt) >= s.maxAge {
			continue
		}
		switch rec.Kind {
		case "file", "discard":
			fi, err := os.Lstat(filepath.Join(s.dir, id))
			if err != nil || !fi.Mode().IsRegular() {
				continue
			}
			if rec.Kind == "file" && s.restoredLinkLocked(rec, fi) {
				continue
			}
		case "dir":
		default:
			continue
		}
		out = append(out, trashEntry{
			TrashID: id, Path: rec.Path, Kind: rec.Kind, DeletedAt: rec.DeletedAt,
			ExpiresAt: rec.DeletedAt.Add(s.maxAge), Size: rec.Size,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].DeletedAt.Equal(out[j].DeletedAt) {
			return out[i].DeletedAt.After(out[j].DeletedAt)
		}
		return out[i].TrashID < out[j].TrashID
	})
	truncated := len(out) > trashListMax
	if truncated {
		out = out[:trashListMax]
	}
	// Only for what is sent: resolving each path costs a few syscalls.
	for i := range out {
		out[i].Sensitive = sensitivePath(root, filepath.FromSlash(out[i].Path))
	}
	return out, truncated, nil
}

// purgeLocked removes the entry id for good, whatever its age, when it was
// deleted under root (errNotInTrash otherwise, as when there is none). The
// payload goes first, only a regular file and never through a symlink; when
// it cannot be removed the record stays, so the entry is still listed and
// can be tried again.
func (s *trashStore) purgeLocked(root, id string) error {
	rec, err := s.readRecordLocked(id)
	if err != nil {
		return err
	}
	if rec.Root != root {
		return errNotInTrash
	}
	trash, err := s.open()
	if err != nil {
		return trashError(err)
	}
	defer trash.Close()
	switch fi, err := trashPayloadStat(trash, id); {
	case err == nil && fi.Mode().IsRegular():
		if err := trashPurge(trash, id); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return purgeError(err)
		}
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		// Unknown whether a payload is there: the record stays with it.
		return purgeError(err)
	}
	s.removeRecordLocked(id)
	return nil
}

// purgeError is a payload that could not be removed, whatever the OS said
// (a file held open on Windows is access denied): logged, a 500.
func purgeError(err error) error {
	return fmt.Errorf("trash payload: %s", err.Error())
}

// purge is purgeLocked under the store's lock.
func (s *trashStore) purge(root, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.purgeLocked(root, id)
}

// handleTrashList serves GET files/trash?root=: the entries of the trash
// deleted under the root. Full clients only, like the routes that change
// the trash: the list names files a view-only client may not read.
func (f *filesAPI) handleTrashList(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// Never the trash of a pane's new directory because the request left
	// the root out.
	if r.URL.Query().Get("root") == "" {
		f.error(w, "files trash", errRootRequired)
		return
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return
	}
	defer cancel()
	if f.trash == nil {
		f.error(w, "files trash", errTrashUnavailable)
		return
	}
	// Reading every record is a burst of I/O: a slot of the raw route's.
	select {
	case f.rawSlots <- struct{}{}:
		defer func() { <-f.rawSlots }()
	default:
		f.error(w, "files trash", errTrashListBusy)
		return
	}
	entries, truncated, err := f.trash.list(req.root.Root)
	if err != nil {
		f.error(w, "files trash", trashError(err))
		return
	}
	if entries == nil {
		entries = []trashEntry{}
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, trashListResponse{Root: req.root.Root, Entries: entries, Truncated: truncated})
}

// handleTrashDelete serves POST files/trash/delete?root=: one entry of the
// root's trash goes for good. It takes no write slot (nothing under the
// root changes), only the store's lock.
func (f *filesAPI) handleTrashDelete(w http.ResponseWriter, r *http.Request) {
	var in trashDeleteRequest
	req, cancel, ok := f.startWrite(w, r, "files trash delete", &in, maxJSONBody)
	if !ok {
		return
	}
	defer cancel()
	if !trashIDRe.MatchString(in.TrashID) {
		f.error(w, "files trash delete", errInvalidTrashID)
		return
	}
	if err := f.trash.purge(req.root.Root, in.TrashID); err != nil {
		f.error(w, "files trash delete", err)
		return
	}
	by, via := auditWho(r)
	auditf("trash-delete", "id", in.TrashID, "by", by, "via", via)
	jsonOK(w, trashDeleteResponse{Root: req.root.Root, TrashID: in.TrashID})
}

// handleTrashEmpty serves POST files/trash/empty?root=: the entries the
// client listed go for good, never one it did not send (deleted since, an
// Undo another device may still offer). An id gone already or deleted under
// another root is skipped; one whose payload cannot be removed counts as
// failed and stays. The lock is taken for each id, not the whole run.
func (f *filesAPI) handleTrashEmpty(w http.ResponseWriter, r *http.Request) {
	var in trashEmptyRequest
	req, cancel, ok := f.startWrite(w, r, "files trash empty", &in, trashEmptyBody)
	if !ok {
		return
	}
	defer cancel()
	if len(in.TrashIDs) == 0 || len(in.TrashIDs) > trashListMax {
		f.error(w, "files trash empty", errTrashIDs)
		return
	}
	for _, id := range in.TrashIDs {
		if !trashIDRe.MatchString(id) {
			f.error(w, "files trash empty", errInvalidTrashID)
			return
		}
	}
	res := trashEmptyResponse{Root: req.root.Root}
	for _, id := range in.TrashIDs {
		switch err := f.trash.purge(req.root.Root, id); {
		case err == nil:
			res.Removed++
		case errors.Is(err, errNotInTrash):
		default:
			log.Printf("trash: purge %s: %v", id, err)
			res.Failed++
		}
	}
	by, via := auditWho(r)
	auditf("trash-empty", "removed", res.Removed, "failed", res.Failed, "by", by, "via", via)
	jsonOK(w, res)
}
