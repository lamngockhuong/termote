package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"slices"
	"strconv"
	"time"
)

// apiVersion is bumped on every breaking change to /api/mux/*. The PWA compares
// it with its own build and reloads when they differ.
const apiVersion = 2

// serverInstall is how this server was installed (installKind), reported by
// health so the PWA can name the update command; serve sets it at start.
var serverInstall = "unknown"

// muxTimeout bounds every backend call made on behalf of one HTTP request.
const muxTimeout = 5 * time.Second

// maxJSONBody caps request bodies on /api/mux/* to prevent memory exhaustion.
const maxJSONBody = 8 * 1024

// maxKeysLen caps a single send-keys payload.
const maxKeysLen = 4096

// maxScrollLines caps a single scroll request, in either direction.
const maxScrollLines = 10000

// Mux is a terminal multiplexer backend (tmux/psmux, herdr) exposed through
// the three-level model group → tab → pane.
type Mux interface {
	Name() string
	Caps() Caps
	Snapshot(ctx context.Context) (Snapshot, error)
	SelectTab(ctx context.Context, tabID string) error
	NewTab(ctx context.Context, groupID, name string) (tabID string, err error)
	// CloseTab and RenameTab act on tabID only while key (Tab.Key) still
	// names the tab there, else errTabChanged; an empty key skips the check.
	CloseTab(ctx context.Context, tabID, key string) error
	RenameTab(ctx context.Context, tabID, name, key string) error
	// MoveTab moves tabID to position index (0-based) among its group's tabs
	// and returns its id afterwards: a tmux id is a window index, which a
	// move changes.
	MoveTab(ctx context.Context, tabID string, index int) (newID string, err error)
	// MoveGroup moves groupID to position index (0-based) among the groups
	// that can move (a Herdr linked worktree cannot, it moves with its
	// repository's workspace).
	MoveGroup(ctx context.Context, groupID string, index int) error
	// NewGroup opens a group (a tmux session, a Herdr workspace) named name,
	// starting in cwd (absolute, already checked), and returns its id.
	NewGroup(ctx context.Context, name, cwd string) (groupID string, err error)
	// CloseGroup closes a group, ending everything running in it.
	CloseGroup(ctx context.Context, groupID string) error
	RenameGroup(ctx context.Context, groupID, name string) error
	// ClosePane closes one pane of a split tab, ending what runs in it.
	ClosePane(ctx context.Context, paneID string) error
	// SplitPane opens a pane beside (right) or under (down) paneID, in cwd
	// (absolute, already checked; empty: paneID's own), without moving the
	// focus, and returns its id.
	SplitPane(ctx context.Context, paneID string, dir SplitDir, cwd string) (newPaneID string, err error)
	// ZoomPane makes paneID fill its tab, or not.
	ZoomPane(ctx context.Context, paneID string, mode ZoomMode) error
	// SwapPane swaps paneID with the pane before or after it in its tab's
	// pane order.
	SwapPane(ctx context.Context, paneID string, dir SwapDir) error
	// ResizePane moves paneID's edge amount cells (1..maxResizeAmount) dir.
	ResizePane(ctx context.Context, paneID string, dir ResizeDir, amount int) error
	SendKeys(ctx context.Context, paneID, keys string) error
	// Scroll moves paneID's view lines rows back into its history (negative:
	// toward the live screen), clamped to what the pane holds.
	Scroll(ctx context.Context, paneID string, lines int) error
	// ReadText writes paneID's plain text to w: up to lines rows of history
	// and the screen, wrapped rows joined, no escape sequences. more: the
	// pane holds history past what was read.
	ReadText(ctx context.Context, paneID string, lines int, w io.Writer) (more bool, err error)
	// Attach opens a terminal on paneID. ctx bounds only the setup; the
	// stream lives until it is closed.
	Attach(ctx context.Context, paneID string, size Size) (TermStream, error)
	Health(ctx context.Context) error
}

// Caps describes behaviour that differs between backends.
type Caps struct {
	// ClientSideSelect: switching tab only changes which pane the client
	// streams; the backend is not told (herdr).
	ClientSideSelect bool `json:"clientSideSelect"`
	// CopyMode: the backend has tmux copy mode.
	CopyMode bool `json:"copyMode"`
	// Scroll: the stream only carries screen renders, so history is scrolled
	// by the backend through /api/mux/panes/{id}/scroll (herdr).
	Scroll bool `json:"scroll"`
	// PaneText: a pane's history and screen can be read as plain text
	// (/api/mux/panes/{id}/text).
	PaneText bool `json:"paneText"`
	// DriveSize: the client can take over the pane size while it shows the
	// pane (the stream's drive message, herdr's control mode).
	DriveSize bool `json:"driveSize"`
	// AgentChat: the backend can tell which agent session a pane runs, so
	// the agent routes (/api/mux/panes/{id}/agent/*) work.
	AgentChat bool `json:"agentChat"`
	// Files: the backend reports a pane's working directory, so the files
	// routes (/api/mux/panes/{id}/files/*) work.
	Files bool `json:"files"`
	// Uploads: the server has a usable upload dir (/api/mux/uploads). Set
	// by the snapshot route, not by the backend.
	Uploads bool `json:"uploads"`
	// Trash: the server has a usable trash (files/delete, files/restore).
	// Set by the snapshot route, not by the backend.
	Trash bool `json:"trash"`
	// Places: Files offers folders besides the pane's (files/places), to
	// a full client only.
	Places bool `json:"places"`
	// Auth: sign-in is on, so the PWA offers Log out. Set by the snapshot
	// route, from the request basicAuth let through.
	Auth bool `json:"auth"`
	// AgentStart: an agent can be started in a pane that shows only its
	// shell (/api/mux/panes/{id}/agent/start): Herdr 0.8.2 or later.
	AgentStart bool `json:"agentStart"`
	// AgentStartCodex: Codex can be started too (AgentStart, and Codex has
	// a Chat view on this OS, codexProcSupported).
	AgentStartCodex bool `json:"agentStartCodex"`
	// Groups: groups can be created, renamed and closed (/api/mux/groups).
	Groups bool `json:"groups"`
	// Push: the server can send Web Push (/api/mux/push/*). Set by the
	// snapshot route, not by the backend.
	Push bool `json:"push"`
	// Worktrees: git worktree workspaces can be listed, created, opened and
	// removed (/api/mux/worktrees): Herdr 0.9.2 or later, not on Windows.
	Worktrees bool `json:"worktrees"`
	// ReorderTabs: a tab can be moved within its group
	// (/api/mux/tabs/{id}/move): Herdr 0.8.0 or later, not on Windows; tmux
	// 3.2 or later (the server's version), not psmux.
	ReorderTabs bool `json:"reorderTabs"`
	// PaneLayout: a pane can be split, zoomed, swapped and resized
	// (/api/mux/panes/{id}/split, zoom, swap, resize): tmux, Herdr 0.9.3 or
	// later and not on Windows, Zellij 0.45.1 or later. Never on psmux.
	PaneLayout bool `json:"paneLayout"`
	// PaneStream: the stream shows one pane, not its tab's layout (Herdr),
	// so zooming, swapping and resizing change only the desktop: the PWA
	// offers split and close alone there.
	PaneStream bool `json:"paneStream,omitempty"`
	// ReorderGroups: a group can be moved (/api/mux/groups/{id}/move):
	// Herdr 0.8.0 or later, not on Windows. tmux has no session order.
	ReorderGroups bool `json:"reorderGroups"`
	// Role: what the signed-in client may do, "full" or "view" (it changes
	// nothing on the server); empty without sign-in. Set by the snapshot
	// route, from the request basicAuth let through.
	Role string `json:"role,omitempty"`
	// Devices: devices can be paired, listed and revoked
	// (/api/mux/devices*): sign-in is on and the device store is usable.
	// Set by the snapshot route.
	Devices bool `json:"devices"`
	// Signins: password sessions can be listed and revoked
	// (/api/mux/signins*): sign-in is on. Set by the snapshot route.
	Signins bool `json:"signins"`
	// Templates: the prompt templates can be read and, by a full client,
	// changed (/api/mux/templates*). Set by the snapshot route.
	Templates bool `json:"templates"`
	// RecentGroups: the groups created last, with their directories, can be
	// read and removed (/api/mux/recent-groups*) by a full client: the
	// server's state dir keeps them and groups can be created. Set by the
	// snapshot route.
	RecentGroups bool `json:"recentGroups"`
	// Tasks: a pane's package.json scripts, Makefile targets and the user's
	// tasks can be listed and run (/api/mux/panes/{id}/tasks*): the files
	// routes work. Set by the snapshot route.
	Tasks bool `json:"tasks"`
	// UserTasks: the user's tasks can be read and changed by a full client
	// (/api/mux/tasks*). Set by the snapshot route.
	UserTasks bool `json:"userTasks"`
	// ViewStream: a view-only client can stream a pane here (the backend
	// attaches a client that changes nothing: Herdr, tmux 3.2 or later).
	// Set by the snapshot route for that role only: the stream refuses it
	// with a 501 a browser's WebSocket cannot read.
	ViewStream bool `json:"viewStream,omitempty"`
}

// snapshotPeeker is a backend whose Snapshot has side effects (tmux makes
// the default session); peekSnapshot reads without them.
type snapshotPeeker interface {
	peekSnapshot(ctx context.Context) (Snapshot, error)
}

// peekSnapshot reads m's panes without changing anything: the push watcher
// runs with no page open.
func peekSnapshot(ctx context.Context, m Mux) (Snapshot, error) {
	if p, ok := m.(snapshotPeeker); ok {
		return p.peekSnapshot(ctx)
	}
	return m.Snapshot(ctx)
}

type Snapshot struct {
	APIVersion int     `json:"apiVersion"`
	Backend    string  `json:"backend"`
	Caps       Caps    `json:"caps"`
	Groups     []Group `json:"groups"`
	// ServerNow is the server's time when it answered (RFC 3339, UTC): the
	// client measures its own clock's offset with it, for each Since.
	ServerNow string `json:"serverNow,omitempty"`
	// InstanceID names this server (kept in its state dir): the PWA keeps
	// open tabs and drafts on the device under it.
	InstanceID string `json:"instanceId,omitempty"`
}

// Group is a tmux session or a herdr workspace.
type Group struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Tabs []Tab  `json:"tabs"`
	// Worktree: the group belongs to a Herdr worktree group, as the
	// repository's own checkout or as a linked worktree.
	Worktree *GroupWorktree `json:"worktree,omitempty"`
}

// GroupWorktree is a group's place in a Herdr worktree group. Branch is the
// checked out branch when known (read in the background, so it can lag).
// Parent is, for a linked worktree, the group of its repository's own
// checkout when that is open; the snapshot lists the worktree right after it.
type GroupWorktree struct {
	Linked bool   `json:"linked"`
	Branch string `json:"branch,omitempty"`
	Parent string `json:"parent,omitempty"`
}

type Tab struct {
	ID string `json:"id"`
	// Key names the same tab for as long as the backend runs, when its id
	// changes: tmux's window id (@N; a tab id is a window index, which a
	// move or renumber-windows shifts), Herdr the tab id.
	Key    string `json:"key"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Panes  []Pane `json:"panes"`
	// Processes: every pane of the tab that reports one, in pane order, when
	// the backend lists panes the snapshot does not carry (tmux: only the
	// active pane is a Pane).
	Processes []ProcessInfo `json:"processes,omitempty"`
}

type Pane struct {
	ID      string       `json:"id"`
	Active  bool         `json:"active"`
	Title   string       `json:"title,omitempty"`
	Agent   *AgentInfo   `json:"agent,omitempty"`
	Process *ProcessInfo `json:"process,omitempty"`
	// key names the same pane while its id shifts (tmux %N), for the push
	// watcher; never sent. Empty means the id.
	key string
}

// paneKey is what names p across snapshots: its key, else its id.
func paneKey(p Pane) string {
	if p.key != "" {
		return p.key
	}
	return p.ID
}

// findSnapshotPane finds pane id in s. With tabIDs (tmux, whose tabs are
// selected on the server), a tab's own id names the tab's active pane too,
// as links, push notifications and clients from before panes were listed
// name it.
func findSnapshotPane(s Snapshot, id string, tabIDs bool) (Group, Tab, Pane, bool) {
	for _, g := range s.Groups {
		for _, t := range g.Tabs {
			if tabIDs && t.ID == id && len(t.Panes) > 0 {
				i := max(slices.IndexFunc(t.Panes, func(p Pane) bool { return p.Active }), 0)
				return g, t, t.Panes[i], true
			}
			for _, p := range t.Panes {
				if p.ID == id {
					return g, t, p, true
				}
			}
		}
	}
	return Group{}, Tab{}, Pane{}, false
}

// ProcessInfo is a pane's foreground process: the first word of the name the
// OS reports, never its arguments or environment (processName).
type ProcessInfo struct {
	Name string `json:"name"`
	Cwd  string `json:"cwd,omitempty"`
}

// AgentInfo is filled by backends that detect coding agents (herdr, and tmux
// for Claude Code).
type AgentInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	// Since is when the agent's status began (RFC 3339, UTC), set by the
	// activity tracker; SinceFirstSeen: it is when the server first saw the
	// agent, which was already in that status.
	Since          string `json:"since,omitempty"`
	SinceFirstSeen bool   `json:"sinceFirstSeen,omitempty"`
}

// inputError is a client mistake; its message is safe to return verbatim.
type inputError string

func (e inputError) Error() string { return string(e) }

// codedError is a failure the client is told about with an HTTP status and a
// machine-readable code (uploads, files/raw, groups). Its message is safe to
// return verbatim.
type codedError struct {
	code   string
	msg    string
	status int
}

func (e *codedError) Error() string { return e.msg }

// errUnsupported is returned by a backend for an operation it does not offer.
var errUnsupported = errors.New("operation not supported by this backend")

// errLastPane refuses to close a tab's last pane: that is closing the tab.
var errLastPane = &codedError{"last_pane", "a tab's last pane is closed by closing the tab", http.StatusConflict}

// registerMuxRoutes mounts /api/mux/* for the given backend. Patterns carry no
// method so a wrong method gets a JSON 405 instead of falling through to the
// /api/ JSON 404 handler.
// uploads is nil when the server has no usable upload dir, push when it
// cannot send Web Push.
func registerMuxRoutes(mux *http.ServeMux, m Mux, tokens *tokenStore, uploads *uploadStore, push *pushStore) *agentAPI {
	// Set below, before any request: the snapshot reads the files routes'
	// trash through it once registerCommandsRoute has wired them.
	var agent *agentAPI
	mux.HandleFunc("/api/mux/health", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		status := "ok"
		if err := m.Health(ctx); err != nil {
			log.Printf("%s health: %v", m.Name(), err)
			status = "degraded"
		}
		// version and pid let the CLI tell this server from an older one
		// still holding the port (start, restart, update); the PWA compares
		// version with its own build and names the update for install.
		h := map[string]any{"status": status, "apiVersion": apiVersion, "backend": m.Name(),
			"version": cliVersion, "pid": os.Getpid(), "install": serverInstall}
		// With sign-in on, whether pairing works: `container status` says
		// so when the state volume is not usable.
		if authenticated(r.Context()) {
			h["devices"] = agent.devices
		}
		jsonOK(w, h)
	})

	mux.HandleFunc("/api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		// A read, but it names what runs in every pane: like the other pane
		// reads, another site's page gets nothing (writeGuard lets GETs by).
		if msg := crossSiteRejection(agent.allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		gen := agent.activity.begin()
		// peek=1 (the service worker naming a push) creates nothing: no
		// page is open, so a closed default session stays closed.
		read := m.Snapshot
		switch {
		case r.URL.Query().Get("peek") == "1":
			read = func(ctx context.Context) (Snapshot, error) { return peekSnapshot(ctx, m) }
		case isViewOnly(r):
			// A view-only client makes nothing either (tmux's default
			// session), nor starts herdr.
			read = func(ctx context.Context) (Snapshot, error) { return viewSnapshot(ctx, m) }
		default:
			// A full client opening the page starts herdr when it is not
			// running, like tmux makes its default session.
			if h, ok := m.(*herdrMux); ok {
				read = h.startingSnapshot
			}
		}
		snap, err := read(ctx)
		if err != nil {
			muxError(w, m, "snapshot", err)
			return
		}
		snap = agent.activity.observe(gen, snap)
		snap.APIVersion = apiVersion
		snap.Backend = m.Name()
		snap.Caps = m.Caps()
		snap.Caps.Uploads = uploads != nil
		snap.Caps.Trash = agent.files != nil && agent.files.trash != nil
		snap.Caps.Places = agent.files != nil && len(agent.files.places) > 0 && snap.Caps.Files && !isViewOnly(r)
		snap.Caps.Auth = authenticated(r.Context())
		if snap.Caps.Auth {
			snap.Caps.Role = string(requestRole(r.Context()))
		}
		if isViewOnly(r) {
			va, ok := m.(viewAttacher)
			snap.Caps.ViewStream = ok && va.CanView(ctx)
		}
		snap.Caps.Push = push != nil
		snap.Caps.Devices = agent.devices
		snap.Caps.Signins = agent.signins
		snap.Caps.Templates = agent.templates
		snap.Caps.RecentGroups = agent.recentGroups && snap.Caps.Groups && !isViewOnly(r)
		snap.Caps.Tasks = agent.tasks && snap.Caps.Files
		snap.Caps.UserTasks = agent.userTasks
		snap.InstanceID = agent.instanceID
		if snap.Groups == nil {
			snap.Groups = []Group{}
		}
		jsonOK(w, snap)
	})

	mux.HandleFunc("/api/mux/tabs", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		var body struct {
			GroupID string `json:"groupId"`
			Name    string `json:"name"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		id, err := m.NewTab(ctx, body.GroupID, body.Name)
		if err != nil {
			muxError(w, m, "new tab", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true, "id": id})
	})

	mux.HandleFunc("/api/mux/tabs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireWriteRole(w, r) {
			return
		}
		id := r.PathValue("id")
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		switch r.Method {
		case http.MethodPatch:
			var body struct {
				Name string `json:"name"`
				Key  string `json:"key"`
			}
			if !decodeJSON(w, r, &body) {
				return
			}
			if err := m.RenameTab(ctx, id, body.Name, body.Key); err != nil {
				muxError(w, m, "rename tab", err)
				return
			}
		case http.MethodDelete:
			if err := m.CloseTab(ctx, id, r.URL.Query().Get("key")); err != nil {
				muxError(w, m, "close tab", err)
				return
			}
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/tabs/{id}/select", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.SelectTab(ctx, r.PathValue("id")); err != nil {
			muxError(w, m, "select tab", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/panes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodDelete) || !requireWriteRole(w, r) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.ClosePane(ctx, r.PathValue("id")); err != nil {
			muxError(w, m, "close pane", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/panes/{id}/keys", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		var body struct {
			Keys string `json:"keys"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if len(body.Keys) > maxKeysLen {
			jsonError(w, "keys too long", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.SendKeys(ctx, r.PathValue("id"), body.Keys); err != nil {
			muxError(w, m, "send keys", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/panes/{id}/scroll", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		var body struct {
			Lines int `json:"lines"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if body.Lines < -maxScrollLines || body.Lines > maxScrollLines {
			jsonError(w, "lines out of range", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.Scroll(ctx, r.PathValue("id"), body.Lines); err != nil {
			muxError(w, m, "scroll", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/uploads", handleUpload(uploads))

	agent = registerAgentRoutes(mux, m, uploads)

	// The status changes the snapshots showed since the server started:
	// ids, keys, agent names and statuses, which the snapshot gives a
	// view-only client too.
	mux.HandleFunc("/api/mux/activity", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if msg := crossSiteRejection(agent.allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		var after uint64
		q := r.URL.Query().Get("after")
		if q != "" {
			n, err := strconv.ParseUint(q, 10, 64)
			if err != nil {
				jsonErrorCode(w, "invalid_after", "after must be a non-negative integer", http.StatusBadRequest)
				return
			}
			after = n
		}
		jsonOK(w, agent.activity.eventsAfter(after, q != ""))
	})

	mux.HandleFunc("/api/mux/panes/{id}/text", handlePaneText(m, agent))

	// Only reachable via fetch/XHR from the PWA, not by direct navigation.
	mux.HandleFunc("/api/mux/stream-token", handleTerminalToken(tokens))
	return agent
}

// decodeJSON reads a size-limited JSON body into v, writing a 400 on failure.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeJSONMax(w, r, v, maxJSONBody)
}

// decodeJSONMax is decodeJSON with a body of up to limit bytes.
func decodeJSONMax(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return false
	}
	return true
}

// muxError maps a backend error to a response. Input errors are returned to the
// client; everything else is logged server-side and answered generically.
func muxError(w http.ResponseWriter, m Mux, op string, err error) {
	var ie inputError
	var ce *codedError
	switch {
	case errors.As(err, &ce):
		jsonErrorCode(w, ce.code, ce.msg, ce.status)
	case errors.As(err, &ie):
		jsonError(w, ie.Error(), http.StatusBadRequest)
	case errors.Is(err, errUnsupported):
		jsonError(w, errUnsupported.Error(), http.StatusNotImplemented)
	default:
		log.Printf("%s %s error: %v", m.Name(), op, err)
		jsonError(w, "mux command failed", http.StatusInternalServerError)
	}
}

// requireMethod returns true if method matches, otherwise writes 405 error
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		w.Header().Set("Allow", method)
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
