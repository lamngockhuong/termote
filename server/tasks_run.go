package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"
)

const (
	taskKindScript = "script"
	taskKindMake   = "make"
	taskKindUser   = "user"

	// maxTaskRuns caps the runs remembered; taskRunTTL drops older ones.
	maxTaskRuns = 200
	taskRunTTL  = 24 * time.Hour
	// taskRunBody bounds a run request: an identifier, never a command.
	taskRunBody = 4 << 10
)

// taskNewShellWait bounds the wait for a new tab's shell to draw its
// prompt: rc files that load nvm or a prompt framework take seconds. A
// variable so tests can shorten it.
var taskNewShellWait = 15 * time.Second

var (
	errNoSuchTask        = &codedError{"task_not_found", "no such task in this pane's root", http.StatusNotFound}
	errTaskRunNotFound   = &codedError{"run_not_found", "no such run", http.StatusNotFound}
	errTaskInvalidRoot   = &codedError{"invalid_root", "the pane's directory cannot be used for a task", http.StatusBadRequest}
	errTaskShell         = &codedError{"unsupported_shell", "this shell is not supported (bash, zsh, sh, fish, pwsh)", http.StatusConflict}
	errTaskShellBusy     = &codedError{"shell_busy", "the tab's shell is busy", http.StatusConflict}
	errTaskStoredInvalid = &codedError{"invalid_task", "this task cannot be run: edit it in Settings", http.StatusBadRequest}
)

// taskRunningError: the task's last run still runs in its tab, and the
// client did not ask for a new one.
type taskRunningError struct {
	runID, tabID string
}

func (e *taskRunningError) Error() string { return "the task is running" }

// resolvedTask is a task as the server read it again for a run: the client
// only named it.
type resolvedTask struct {
	Kind, Name, ID string
	// PackageManager runs a script; Command is a user task's.
	PackageManager, Command string
	// Head and PwshHead start a tool task's line (toolGroup), Args follow
	// it, each quoted.
	Head, PwshHead string
	Args           []string
}

// clientKey names the task in the list's runs: kind and name, or user and
// id (a user task can be renamed).
func (t resolvedTask) clientKey() string {
	if t.Kind == taskKindUser {
		return t.Kind + ":" + t.ID
	}
	return t.Kind + ":" + t.Name
}

// taskRun is one run of a task in a tab. The fields after started change
// as the run is checked, under taskRuns.mu.
type taskRun struct {
	id, key, clientKey string
	root               string
	tabID, paneID      string
	target, nonce      string
	started            time.Time

	// state is running until a check finds it exited, ended or gone, which
	// never change again; code is an exited run's status.
	state   string
	code    int
	checked time.Time
	// sawBusy: a check found the shell running something; idleSince: when
	// the checks first found it back at its prompt
	sawBusy   bool
	idleSince time.Time
	// checkMu lets one check of the run read the pane at a time.
	checkMu sync.Mutex
	// typed: the line was typed. A tab opened for a run whose line could
	// not be typed is remembered, untyped, for the next run of the task,
	// and shown to no client.
	typed bool
}

// taskRuns remembers the runs of this server's life: a restart forgets
// them (the client then shows the last state as unknown).
type taskRuns struct {
	mu     sync.Mutex
	runs   map[string]*taskRun
	latest map[string]string // key → id of its last run
	keys   map[string]*sync.Mutex
	now    func() time.Time
}

func newTaskRuns() *taskRuns {
	return &taskRuns{runs: map[string]*taskRun{}, latest: map[string]string{}, keys: map[string]*sync.Mutex{}, now: time.Now}
}

// taskRunKey names a task within its root.
func taskRunKey(root, clientKey string) string { return root + "\x00" + clientKey }

// lockKey holds key's lock: from looking up the last run until the new one
// is typed, so two devices pressing Run at once open one tab.
func (rs *taskRuns) lockKey(key string) func() {
	for {
		rs.mu.Lock()
		m := rs.keys[key]
		if m == nil {
			m = &sync.Mutex{}
			rs.keys[key] = m
		}
		rs.mu.Unlock()
		m.Lock()
		// drop may have forgotten m between the lookup and the Lock: a
		// request that comes now makes another, so take the map's.
		rs.mu.Lock()
		current := rs.keys[key] == m
		rs.mu.Unlock()
		if current {
			return m.Unlock
		}
		m.Unlock()
	}
}

func (rs *taskRuns) get(id string) *taskRun {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r := rs.runs[id]; r != nil && r.typed {
		return r
	}
	return nil
}

func (rs *taskRuns) last(key string) *taskRun {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.runs[rs.latest[key]]
}

// add records run as its key's last, dropping runs older than taskRunTTL
// and then the oldest past maxTaskRuns.
func (rs *taskRuns) add(run *taskRun) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.runs[run.id] = run
	rs.latest[run.key] = run.id
	now := rs.now()
	var all []*taskRun
	for _, r := range rs.runs {
		if now.Sub(r.started) > taskRunTTL {
			rs.drop(r)
			continue
		}
		all = append(all, r)
	}
	if len(all) > maxTaskRuns {
		slices.SortFunc(all, func(a, b *taskRun) int { return a.started.Compare(b.started) })
		for _, r := range all[:len(all)-maxTaskRuns] {
			rs.drop(r)
		}
	}
}

// drop forgets r (rs.mu held), and its key's lock when no request holds it.
func (rs *taskRuns) drop(r *taskRun) {
	delete(rs.runs, r.id)
	if rs.latest[r.key] != r.id {
		return
	}
	delete(rs.latest, r.key)
	if m := rs.keys[r.key]; m != nil && m.TryLock() {
		delete(rs.keys, r.key)
		m.Unlock()
	}
}

// inRoot returns the last run of each task of root, by client key.
func (rs *taskRuns) inRoot(root string) map[string]taskRunInfo {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := map[string]taskRunInfo{}
	for _, id := range rs.latest {
		if r := rs.runs[id]; r != nil && r.root == root && r.typed {
			out[r.clientKey] = r.infoLocked()
		}
	}
	return out
}

// taskRunInfo is a run as clients see it: enough to open its tab, poll it
// and find its output between the markers.
type taskRunInfo struct {
	RunID  string `json:"runId"`
	TabID  string `json:"tabId"`
	PaneID string `json:"paneId"`
	Nonce  string `json:"nonce"`
	State  string `json:"state"`
	Code   *int   `json:"code,omitempty"`
}

func (r *taskRun) infoLocked() taskRunInfo {
	info := taskRunInfo{RunID: r.id, TabID: r.tabID, PaneID: r.paneID, Nonce: r.nonce, State: r.state}
	if r.state == taskStateExited {
		code := r.code
		info.Code = &code
	}
	return info
}

func newTaskNonce() string {
	var b [8]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// taskRunRequest names the task to run, never its command.
type taskRunRequest struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	ID   string `json:"id"`
	// Root is the root the client listed the task in.
	Root   string `json:"root"`
	NewTab bool   `json:"newTab"`
}

// resolve finds the task named in req among what root offers now.
func (t *tasksAPI) resolve(ctx context.Context, req taskRunRequest, root string) (resolvedTask, error) {
	switch {
	case req.Kind == taskKindScript || req.Kind == taskKindMake || isToolKind(req.Kind):
		if !validTaskName(req.Name) {
			return resolvedTask{}, errNoSuchTask
		}
		found, err := t.discoverRoot(ctx, root, isToolKind(req.Kind))
		if err != nil {
			return resolvedTask{}, err
		}
		if req.Kind == taskKindScript && slices.ContainsFunc(found.Scripts, func(s scriptTask) bool { return s.Name == req.Name }) {
			return resolvedTask{Kind: req.Kind, Name: req.Name, PackageManager: found.PackageManager}, nil
		}
		if req.Kind == taskKindMake && slices.ContainsFunc(found.MakeTargets, func(m makeTarget) bool { return m.Name == req.Name }) {
			return resolvedTask{Kind: req.Kind, Name: req.Name}, nil
		}
		for _, g := range found.ToolGroups {
			if g.Tool != req.Kind {
				continue
			}
			if i := slices.IndexFunc(g.Tasks, func(tt toolTask) bool { return tt.Name == req.Name }); i >= 0 {
				return resolvedTask{Kind: req.Kind, Name: req.Name, Head: g.head, PwshHead: g.pwshHead, Args: g.Tasks[i].args}, nil
			}
		}
	case req.Kind == taskKindUser:
		if t.store != nil && validTemplateID(req.ID) {
			if u, ok := t.store.task(req.ID); ok {
				// Checked again: the file can be edited by hand, or written
				// by a newer Termote with other limits.
				if _, _, err := validateTask(u.Name, u.Command); err != nil {
					return resolvedTask{}, errTaskStoredInvalid
				}
				return resolvedTask{Kind: req.Kind, ID: u.ID, Name: u.Name, Command: u.Command}, nil
			}
		}
	default:
		return resolvedTask{}, errTaskUnknownKind
	}
	return resolvedTask{}, errNoSuchTask
}

// handleRun runs a task of the pane's root in a tab at that root: the tab
// of the task's last run when its shell waits at its prompt, else a new
// one.
func (t *tasksAPI) handleRun(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	var body taskRunRequest
	r.Body = http.MaxBytesReader(w, r.Body, taskRunBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			jsonErrorCode(w, "too_large", "request body too large", http.StatusRequestEntityTooLarge)
		} else {
			jsonError(w, "invalid JSON body", http.StatusBadRequest)
		}
		return
	}
	tm, ok := t.files.m.(taskMux)
	if !ok {
		t.files.error(w, "task run", errUnsupported)
		return
	}
	req, cancel, ok := t.start(w, r)
	if !ok {
		return
	}
	defer cancel()
	root := req.root.Root
	if body.Root != root {
		t.files.error(w, "task run", &rootChangedError{root})
		return
	}
	task, err := t.resolve(req.ctx, body, root)
	if err == nil && !validTaskDir(root) {
		err = errTaskInvalidRoot
	}
	if err != nil {
		t.files.error(w, "task run", err)
		return
	}
	// Bounds the waits for the shell (a new one's taskNewShellWait), the
	// clear, a new tab and the typing. Not cut short by the client leaving:
	// a half-typed line is worse than one it never sees run.
	ctx, cancelRun := context.WithTimeout(context.WithoutCancel(req.ctx), taskNewShellWait+3*agentStartIdleWait+2*muxTimeout)
	defer cancelRun()
	info, reused, err := t.run(ctx, tm, r.PathValue("id"), root, task, body.NewTab)
	var running *taskRunningError
	if errors.As(err, &running) {
		jsonCodeBody(w, http.StatusConflict, map[string]string{"error": running.Error(), "code": "task_running",
			"runId": running.runID, "tabId": running.tabID})
		return
	}
	if err != nil {
		t.files.error(w, "task run", err)
		return
	}
	by, via := auditWho(r)
	if task.Kind == taskKindUser {
		auditf("task-run", "kind", task.Kind, "id", task.ID, "by", by, "via", via)
	} else {
		auditf("task-run", "kind", task.Kind, "name", task.Name, "by", by, "via", via)
	}
	jsonOK(w, map[string]any{"runId": info.RunID, "tabId": info.TabID, "paneId": info.PaneID,
		"nonce": info.Nonce, "reused": reused})
}

// run types task's line into the tab of its last run, or a new tab, under
// the task's lock.
func (t *tasksAPI) run(ctx context.Context, tm taskMux, paneID, root string, task resolvedTask, newTab bool) (taskRunInfo, bool, error) {
	key := taskRunKey(root, task.clientKey())
	unlock := t.runs.lockKey(key)
	defer unlock()
	var tab taskTab
	reused := false
	if prev := t.runs.last(key); prev != nil {
		state := t.check(ctx, tm, prev, true)
		if state.State == taskStateRunning && !newTab {
			return taskRunInfo{}, false, &taskRunningError{prev.id, prev.tabID}
		}
		if state.State != taskStateRunning && state.State != taskStateGone && !newTab {
			if _, idle, err := tm.IdleShell(ctx, prev.target); err == nil && idle {
				tab, reused = taskTab{TabID: prev.tabID, PaneID: prev.paneID, Target: prev.target}, true
			}
		}
	}
	if !reused {
		groupID, err := paneGroup(ctx, t.files.m, paneID)
		if err != nil {
			return taskRunInfo{}, false, err
		}
		name := "task:" + task.Name
		if isToolKind(task.Kind) {
			// Two tools may both have a "test".
			name = "task:" + task.Kind + ":" + task.Name
		}
		if tab, err = tm.NewTaskTab(ctx, groupID, name, root); err != nil {
			return taskRunInfo{}, false, err
		}
	}
	nonce := newTaskNonce()
	run := &taskRun{id: newTaskNonce(), key: key, clientKey: task.clientKey(), root: root,
		tabID: tab.TabID, paneID: tab.PaneID, target: tab.Target, nonce: nonce,
		started: t.runs.now(), state: taskStateRunning, typed: true}
	if err := t.typeTask(ctx, tm, tab.Target, task, nonce, reused); err != nil {
		if !reused {
			// The tab stays open: kept as the key's last run, ended, so the
			// next Run types there once its shell waits (a slow rc, an
			// unsupported shell) instead of opening one more tab.
			run.state, run.typed = taskStateEnded, false
			t.runs.add(run)
		}
		return taskRunInfo{}, false, err
	}
	t.runs.add(run)
	t.runs.mu.Lock()
	defer t.runs.mu.Unlock()
	return run.infoLocked(), reused, nil
}

// typeTask waits for target's shell, clears its input line in a tab used
// before (a new shell may still run its rc files, which C-c would cut
// short), checks the shell again and types the task's line. It holds the
// pane's input lock, which the agent routes share, so nothing else types
// in between.
func (t *tasksAPI) typeTask(ctx context.Context, tm taskMux, target string, task resolvedTask, nonce string, reused bool) error {
	unlock := t.input.lock(target)
	defer unlock()
	shell, err := waitTaskShell(ctx, tm, target, !reused)
	if err != nil {
		return err
	}
	if reused {
		if err := tm.Interrupt(ctx, target); err != nil {
			return err
		}
		if err := taskSleep(ctx, agentStartClearWait); err != nil {
			return err
		}
		if shell, err = waitTaskShell(ctx, tm, target, false); err != nil {
			return err
		}
	}
	kind := taskShellKind(shell)
	if kind == "" {
		return errTaskShell
	}
	cmd := taskCommand(kind, task)
	if cmd == "" {
		return errTaskUnknownKind
	}
	return tm.TypeLine(ctx, target, buildTaskLine(kind, cmd, nonce))
}

// waitTaskShell waits up to agentStartIdleWait for target's shell to wait
// at its prompt; with settle, also for the pane's text to stop changing, so
// a new shell has drawn its prompt (its rc files done) before anything is
// typed.
func waitTaskShell(ctx context.Context, tm taskMux, target string, settle bool) (string, error) {
	deadline := time.Now().Add(agentStartIdleWait)
	if settle {
		deadline = time.Now().Add(taskNewShellWait)
	}
	prev, seen := "", false
	for {
		shell, idle, err := tm.IdleShell(ctx, target)
		if err != nil {
			return "", err
		}
		if idle && settle {
			text, err := tm.ReadTaskText(ctx, target, taskReadLines)
			if err != nil {
				return "", err
			}
			idle = seen && text == prev && taskPromptShown(text)
			prev, seen = text, true
		}
		if idle {
			return shell, nil
		}
		if !time.Now().Add(agentStartIdlePoll).Before(deadline) {
			return "", errTaskShellBusy
		}
		if err := taskSleep(ctx, agentStartIdlePoll); err != nil {
			return "", err
		}
	}
}

// taskSleep waits d, or until ctx ends.
func taskSleep(ctx context.Context, d time.Duration) error {
	select {
	case <-time.After(d):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// taskPromptShown: the pane shows something (a prompt) on its last line.
func taskPromptShown(text string) bool {
	for i := len(text) - 1; i >= 0; i-- {
		switch text[i] {
		case '\n', '\r', ' ', '\t':
			continue
		}
		return true
	}
	return false
}

// paneGroup finds the group paneID is in.
func paneGroup(ctx context.Context, m Mux, paneID string) (string, error) {
	snap, err := peekSnapshot(ctx, m)
	if err != nil {
		return "", err
	}
	if g, _, _, ok := findSnapshotPane(snap, paneID, !m.Caps().ClientSideSelect); ok {
		return g.ID, nil
	}
	return "", inputError("unknown pane")
}
