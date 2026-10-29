package main

import (
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
)

// recentGroupView is an entry as a client sees it: never the resolved
// directory.
type recentGroupView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

// registerRecentGroupRoutes mounts /api/mux/recent-groups*. store is nil
// when the state dir cannot hold them; the routes then answer 503
// recent_unavailable. Only a full client reads them (same-site only: they
// name projects) or removes one; nothing here takes a path, the group
// routes record what was created. deny is the group routes' deny list.
// Not under /api/mux/groups/: /api/mux/groups/recent/{id} would clash with
// /api/mux/groups/{id}/move.
func registerRecentGroupRoutes(mux *http.ServeMux, store *recentGroupStore, deny []string, allowed hostAllowlist) {
	mux.HandleFunc("/api/mux/recent-groups", func(w http.ResponseWriter, r *http.Request) {
		if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodGet) {
			return
		}
		// A read, but it names projects: another site's page gets nothing
		// (writeGuard lets GETs by).
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if store == nil {
			writeRecentError(w, errRecentUnavailable)
			return
		}
		list, readOnly := store.entries()
		// Checked as strings only, never stat'ed (underDir stats a path that
		// differs in case on Linux): a hung mount does not hold the list
		// up, and on Windows no symlink is followed to a share. A directory
		// gone since shows, and Create says not_found.
		denied := func(g recentGroup) bool {
			for _, d := range deny {
				if underDirName(d, g.Cwd) || underDirName(d, g.Real) {
					return true
				}
			}
			return false
		}
		out := []recentGroupView{}
		prune := false
		for _, g := range list {
			if denied(g) {
				prune = true
				continue
			}
			out = append(out, recentGroupView{g.ID, g.Name, g.Cwd})
		}
		// Dropped from the file only when the lock is free right away: the
		// read never waits for another process.
		if prune {
			if err := store.prune(denied); err != nil && !errors.Is(err, errRecentBusy) {
				log.Printf("recent groups: %v", err)
			}
		}
		jsonOK(w, map[string]any{"groups": out, "readOnly": readOnly})
	})

	mux.HandleFunc("/api/mux/recent-groups/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodDelete) {
			return
		}
		if store == nil {
			writeRecentError(w, errRecentUnavailable)
			return
		}
		if err := store.remove(r.PathValue("id")); err != nil {
			writeRecentError(w, err)
			return
		}
		jsonOK(w, map[string]bool{"ok": true})
	})
}

// underDirName is underDir by the names alone: without case where the file
// system usually ignores it, exactly elsewhere.
func underDirName(dir, p string) bool {
	if dir == "" {
		return false
	}
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		dir, p = strings.ToLower(dir), strings.ToLower(p)
	}
	rel, err := filepath.Rel(dir, p)
	return err == nil && filepath.IsLocal(rel)
}

// writeRecentError answers a codedError with its code and anything else (a
// failed read or save) with a generic 500, logged: no OS text or path
// reaches the client.
func writeRecentError(w http.ResponseWriter, err error) {
	var ce *codedError
	if errors.As(err, &ce) {
		jsonErrorCode(w, ce.code, ce.msg, ce.status)
		return
	}
	log.Printf("recent groups: %v", err)
	jsonError(w, "could not change the recent groups", http.StatusInternalServerError)
}
