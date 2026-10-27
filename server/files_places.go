package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// A Place is a host folder the operator allowed with --allow-path: Files
// serves it like a pane's root, picked by an opaque id. No route adds,
// removes or widens one.
type place struct {
	ID   string
	Name string
	// Path is the folder as configured (inside the container, its mount);
	// Resolved is where it led through symlinks when the server started.
	Path     string
	Resolved string
}

// placeSpec is a Place as configured; an empty ID or Name is derived from
// the path.
type placeSpec struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// placeCheckTTL is how long where a Place leads is taken as checked; a var
// for tests.
var placeCheckTTL = time.Second

var (
	errUnknownPlace      = &codedError{"unknown_place", "no such place", http.StatusNotFound}
	errPlaceMoved        = &codedError{"place_moved", "the place no longer leads to the folder allowed", http.StatusForbidden}
	errPlaceNotSupported = &codedError{"place_not_supported", "not available in a place", http.StatusBadRequest}
)

// placeID is the id of a Place: the first 16 hex of the sha256 of its host
// path, so the container's ids match the native ones whatever its mounts.
func placeID(hostPath string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(hostPath)))
	return hex.EncodeToString(sum[:])[:16]
}

// placeNames names each path by its base name; a name two paths share gets
// the parent's base name after it: "notes (work)".
func placeNames(paths []string) []string {
	base := func(p string) string { return filepath.Base(filepath.Clean(p)) }
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = base(p)
		if slices.ContainsFunc(paths, func(q string) bool { return q != p && strings.EqualFold(base(q), out[i]) }) {
			out[i] += " (" + base(filepath.Dir(filepath.Clean(p))) + ")"
		}
	}
	return out
}

// placeSpecs turns host paths (the saved --allow-path list) into specs.
func placeSpecs(paths []string) []placeSpec {
	names := placeNames(paths)
	out := make([]placeSpec, len(paths))
	for i, p := range paths {
		out[i] = placeSpec{ID: placeID(p), Name: names[i], Path: p}
	}
	return out
}

// parsePlacesEnv reads TERMOTE_PLACES: a JSON list of {"id","name","path"}
// (the container passes the host ids and names with its mount paths).
func parsePlacesEnv(s string) []placeSpec {
	if s == "" {
		return nil
	}
	var specs []placeSpec
	if err := json.Unmarshal([]byte(s), &specs); err != nil {
		log.Printf("files: TERMOTE_PLACES ignored: %v", err)
		return nil
	}
	return specs
}

// buildPlaces checks each configured Place again, as start does, against
// this server's own user and dirs, and skips one that fails with a log line.
func buildPlaces(specs []placeSpec, env allowPathEnv) []place {
	var out []place
	for _, s := range specs {
		if !filepath.IsAbs(s.Path) {
			log.Printf("files: place %q skipped: not an absolute path", s.Path)
			continue
		}
		p := filepath.Clean(s.Path)
		if err := validateAllowPath(p, env); err != nil {
			log.Printf("files: place %s skipped: %v", p, err)
			continue
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			log.Printf("files: place %s skipped: %v", p, err)
			continue
		}
		pl := place{ID: s.ID, Name: s.Name, Path: p, Resolved: real}
		if pl.ID == "" {
			pl.ID = placeID(p)
		}
		if pl.Name == "" {
			pl.Name = filepath.Base(p)
		}
		if slices.ContainsFunc(out, func(o place) bool { return o.ID == pl.ID }) {
			log.Printf("files: place %s skipped: its id is taken", p)
			continue
		}
		out = append(out, pl)
	}
	return out
}

// setPlaces installs the Places; the container trusts their repos as it
// trusts the mounted workspace.
func (f *filesAPI) setPlaces(places []place) {
	f.places = places
	f.roots.placeDirs = nil
	for _, p := range places {
		f.roots.placeDirs = append(f.roots.placeDirs, p.Resolved)
	}
}

// placeRoot is the root of the Place id. The folder is resolved again (for
// a short while cached) and refused once it leads elsewhere than when the
// server started: a symlink swapped since. The root is the Place itself,
// never a repo around it, whose git dir stays denied.
func (f *filesAPI) placeRoot(ctx context.Context, id string) (filesRoot, error) {
	if f.dirs == nil || !f.m.Caps().Files {
		return filesRoot{}, errUnsupported
	}
	i := slices.IndexFunc(f.places, func(p place) bool { return p.ID == id })
	if i < 0 {
		return filesRoot{}, errUnknownPlace
	}
	p := f.places[i]
	now, err := f.placeNow.do(p.Path, func() (string, error) { return filepath.EvalSymlinks(p.Path) })
	if err != nil || now != p.Resolved {
		log.Printf("files: place %s no longer leads to %s, refused", p.Path, p.Resolved)
		return filesRoot{}, errPlaceMoved
	}
	res, err := f.roots.resolve(ctx, p.Resolved)
	if err != nil {
		return filesRoot{}, err
	}
	if res.Root == p.Resolved {
		return res, nil
	}
	return filesRoot{Root: p.Resolved, GitDir: res.GitDir}, nil
}

// placeRefused reports a route that serves no Place: Changes (status, diff,
// apply, the last commit) and an image version of a change stay pane-scoped.
func placeRefused(r *http.Request) bool {
	p := r.URL.Path
	for _, s := range []string{"/files/changes", "/files/changes/apply", "/files/diff", "/files/commit", "/files/commit/diff"} {
		if strings.HasSuffix(p, s) {
			return true
		}
	}
	return strings.HasSuffix(p, "/files/raw") && r.URL.Query().Get("side") != ""
}

// keyDirs are the server user's ~/.ssh and ~/.gnupg, never served by Files
// in any root.
func keyDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	return []string{filepath.Join(home, ".ssh"), filepath.Join(home, ".gnupg")}
}

type placeEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Path is the resolved root, as files/tree reports it.
	Path string `json:"path"`
}

// handlePlaces serves GET /api/mux/files/places: the Places a full client
// may open; a view-only client gets none.
func (f *filesAPI) handlePlaces(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(f.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireFilesRead(w, r) {
		return
	}
	out := []placeEntry{}
	if !isViewOnly(r) {
		for _, p := range f.places {
			out = append(out, placeEntry{ID: p.ID, Name: p.Name, Path: p.Resolved})
		}
	}
	jsonOK(w, map[string]any{"places": out})
}
