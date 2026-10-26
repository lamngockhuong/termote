package main

import (
	"context"
	"errors"
	"net/http"
	"os"
)

// tasksAPI serves /api/mux/panes/{id}/tasks*: the package.json scripts and
// Makefile targets in a pane's root (the files routes' root) and the user's
// tasks, and runs one in a tab at that root.
type tasksAPI struct {
	files *filesAPI
	// store holds the user's tasks; nil when the server has none.
	store *taskStore
	runs  *taskRuns
	// input is the agent routes' per-pane lock: a task is typed under it.
	input *agentInput
}

// registerTaskRoutes mounts the pane tasks routes on top of the files
// routes, whose roots and checks they share.
func registerTaskRoutes(mux *http.ServeMux, files *filesAPI, store *taskStore, input *agentInput) *tasksAPI {
	t := &tasksAPI{files: files, store: store, runs: newTaskRuns(), input: input}
	mux.HandleFunc("/api/mux/panes/{id}/tasks", t.handleList)
	mux.HandleFunc("/api/mux/panes/{id}/tasks/run", t.handleRun)
	mux.HandleFunc("/api/mux/tasks/runs/{runId}", t.handleRunState)
	return t
}

// paneTasks is what a pane's root offers to run.
type paneTasks struct {
	Root           string       `json:"root"`
	PackageManager string       `json:"packageManager"`
	Scripts        []scriptTask `json:"scripts"`
	Makefile       string       `json:"makefile"`
	MakeTargets    []makeTarget `json:"makeTargets"`
	UserTasks      []userTask   `json:"userTasks"`
	// Skipped counts the scripts and targets left out: a name the view
	// cannot run, or past maxTaskItems.
	Skipped int `json:"skipped"`
	// TooLarge names package.json or the Makefile when larger than
	// maxTaskFile: read as having nothing.
	TooLarge []string `json:"tooLarge"`
	// Runs is the last run of each task in this root, by kind:name (or
	// user:id), as last checked: every device shows the same.
	Runs map[string]taskRunInfo `json:"runs"`
}

// discover reads root's package.json and Makefile through os.Root, running
// nothing, and the user's tasks.
func (t *tasksAPI) discover(root string) (paneTasks, error) {
	out := paneTasks{Root: root, Scripts: []scriptTask{}, MakeTargets: []makeTarget{}, UserTasks: []userTask{}, TooLarge: []string{}}
	rt, err := os.OpenRoot(root)
	if err != nil {
		return out, err
	}
	defer rt.Close()
	read := func(name string) []byte {
		if t.files.denied(root, name) {
			return nil
		}
		b, err := readTaskFile(rt, name)
		if errors.Is(err, errTaskFileTooLarge) {
			out.TooLarge = append(out.TooLarge, name)
		}
		return b
	}
	if b := read("package.json"); b != nil {
		scripts, field, skipped := parsePackageJSON(b)
		if scripts != nil {
			out.Scripts = scripts
		}
		out.Skipped += skipped
		out.PackageManager = detectPackageManager(rt, field)
	}
	if name := pickMakefile(rt); name != "" {
		out.Makefile = name
		if b := read(name); b != nil {
			targets, skipped := parseMakeTargets(b)
			if targets != nil {
				out.MakeTargets = targets
			}
			out.Skipped += skipped
		}
	}
	if t.store != nil {
		out.UserTasks, _ = t.store.tasks()
	}
	return out, nil
}

// start checks a pane tasks request: same-site, a full client only (the
// commands it lists and runs are the user's), the pane's root as the client
// saw it. A view-only client is refused before git runs for the root.
func (t *tasksAPI) start(w http.ResponseWriter, r *http.Request) (*filesRequest, context.CancelFunc, bool) {
	return t.files.start(w, r, requireWriteRole)
}

func (t *tasksAPI) handleList(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	req, cancel, ok := t.start(w, r)
	if !ok {
		return
	}
	defer cancel()
	res, err := t.discover(req.root.Root)
	if err != nil {
		t.files.error(w, "tasks list", err)
		return
	}
	res.Runs = t.runs.inRoot(req.root.Root)
	jsonOK(w, res)
}
