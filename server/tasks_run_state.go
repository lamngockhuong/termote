package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"
)

const (
	taskStateRunning = "running"
	taskStateExited  = "exited"
	taskStateEnded   = "ended"
	taskStateGone    = "gone"

	// taskReadLines is how far back a check looks for the end marker.
	taskReadLines = 400
	// taskStateTTL: a run's state is checked at most this often, whoever
	// asks.
	taskStateTTL = 2 * time.Second
	// taskEndedIdle: a shell back at its prompt this long with no end marker
	// in sight (the screen was cleared) ended its run, code unknown; only
	// once it was seen busy, or the run is taskEndedAge old.
	taskEndedIdle = 2 * time.Second
	taskEndedAge  = 5 * time.Second
)

// check returns run's state, reading the pane when the last check is older
// than taskStateTTL (fresh: always). A shell still running something is
// running without its text being read. The markers are a hint: a program
// in the same terminal can print one.
func (t *tasksAPI) check(ctx context.Context, tm taskMux, run *taskRun, fresh bool) taskRunInfo {
	run.checkMu.Lock()
	defer run.checkMu.Unlock()
	rs := t.runs
	rs.mu.Lock()
	done := run.state != taskStateRunning || !fresh && rs.now().Sub(run.checked) < taskStateTTL
	info := run.infoLocked()
	rs.mu.Unlock()
	if done {
		return info
	}
	state, code := t.read(ctx, tm, run)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	run.state, run.code, run.checked = state, code, rs.now()
	return run.infoLocked()
}

// read looks at run's pane once (run.checkMu held).
func (t *tasksAPI) read(ctx context.Context, tm taskMux, run *taskRun) (string, int) {
	rs := t.runs
	_, idle, err := tm.IdleShell(ctx, run.target)
	if errors.Is(err, errTaskTargetGone) {
		return taskStateGone, 0
	}
	if err != nil {
		log.Printf("task run check: %v", err)
		return taskStateRunning, 0
	}
	now := rs.now()
	rs.mu.Lock()
	if !idle {
		run.sawBusy, run.idleSince = true, time.Time{}
	} else if run.idleSince.IsZero() {
		run.idleSince = now
	}
	sawBusy, idleSince := run.sawBusy, run.idleSince
	rs.mu.Unlock()
	if !idle {
		return taskStateRunning, 0
	}
	text, err := tm.ReadTaskText(ctx, run.target, taskReadLines)
	if err != nil {
		log.Printf("task run read: %v", err)
		return taskStateRunning, 0
	}
	if code, ok := parseTaskExit(text, run.nonce); ok {
		return taskStateExited, code
	}
	if (sawBusy || now.Sub(run.started) >= taskEndedAge) && now.Sub(idleSince) >= taskEndedIdle {
		return taskStateEnded, 0
	}
	return taskStateRunning, 0
}

// handleRunState answers GET /api/mux/tasks/runs/{runId}: same-site, a
// full client only.
func (t *tasksAPI) handleRunState(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(t.files.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	run := t.runs.get(r.PathValue("runId"))
	tm, ok := t.files.m.(taskMux)
	if run == nil || !ok {
		jsonErrorCode(w, errTaskRunNotFound.code, errTaskRunNotFound.msg, errTaskRunNotFound.status)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	defer cancel()
	info := t.check(ctx, tm, run, false)
	res := map[string]any{"state": info.State}
	if info.Code != nil {
		res["code"] = *info.Code
	}
	jsonOK(w, res)
}
