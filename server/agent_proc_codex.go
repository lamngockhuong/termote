package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// Finding the Codex process of a pane (tmux) or of a session id (herdr). Only
// a Codex TUI run with --no-daemon writes its own rollout: by default a
// shared `codex app-server --managed-daemon` writes every pane's rollout, and
// that daemon is not under any pane but the one that started it (checked on
// Codex 0.159.3). So a process counts as Codex when its executable is named
// codex, it is not an app-server, and it holds open for writing exactly one
// rollout of a user thread inside its own CODEX_HOME/sessions. The file read
// is that file, never one looked up by name.

const codexExeName = "codex"

// procWriteFilesFn is procWriteFiles; tests count the calls through it.
var procWriteFilesFn = procWriteFiles

// procFile is a file a process holds open for writing.
type procFile struct {
	path string // as the process opened it
	id   string // fileIdentity of the open file, "" where unknown
}

// codexProcOf checks whether pid is a Codex TUI that may write its own
// rollout. The executable name is checked first: it is cheap, so a pane
// without Codex never has its files listed.
func codexProcOf(pid int) (claudeProc, bool) {
	if !codexProcSupported || procExeBase(pid) != codexExeName {
		return claudeProc{}, false
	}
	// The argv must be readable to tell the TUI from the daemon.
	if args := procArgs(pid); len(args) == 0 || slices.Contains(args, "app-server") {
		return claudeProc{}, false
	}
	home, homeOK := procCodexHome(pid)
	start, startOK := procStartTime(pid)
	if !homeOK || !startOK {
		return claudeProc{}, false
	}
	return claudeProc{agent: "codex", pid: pid, procStart: start, codexHome: home}, true
}

// codexHomeFromEnv is CODEX_HOME, else $HOME/.codex, from a process's
// environment. A relative value would resolve against the server's cwd.
func codexHomeFromEnv(get func(string) string) (string, bool) {
	if v := get("CODEX_HOME"); v != "" {
		return v, filepath.IsAbs(v)
	}
	home := get("HOME")
	if !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, ".codex"), true
}

// codexRollout returns the one rollout of a user thread that pid holds open
// for writing inside home/sessions (of session wantID when it is set): its
// resolved path, the session id from its name and its file identity.
func codexRollout(pid int, home, wantID string) (path, id, fileID string, ok bool) {
	root, err := filepath.EvalSymlinks(filepath.Join(home, "sessions"))
	if err != nil {
		return "", "", "", false
	}
	files := procWriteFilesFn(pid, func(name string) bool { return codexRolloutRe.MatchString(name) })
	found := 0
	for _, f := range files {
		real, err := filepath.EvalSymlinks(f.path)
		if err != nil || !pathWithin(root, real) || real == path {
			continue // outside sessions, or the same file on another fd
		}
		m := codexRolloutRe.FindStringSubmatch(filepath.Base(real))
		if m == nil || (wantID != "" && m[1] != wantID) {
			continue
		}
		// The path must still name the file the process has open.
		fi, err := os.Stat(real)
		if err != nil || !fi.Mode().IsRegular() || (f.id != "" && fileIdentity(fi) != f.id) {
			continue
		}
		fid := fileIdentity(fi)
		if !codexUserThreadCached(real, m[1], fid) {
			continue // a sub-agent's thread
		}
		found++
		path, id, fileID = real, m[1], fid
	}
	// After /new the process keeps the old rollout open too: two user
	// threads, and no telling which one the pane shows.
	if found != 1 {
		return "", "", "", false
	}
	return path, id, fileID, true
}

// codexMetaMax caps the first line read: session_meta can carry the model's
// base instructions.
const codexMetaMax = 1 << 20

// codexUserThread reports whether the rollout's session_meta (its first
// line) is of thread id started by the user.
func codexUserThread(path, id string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	line, err := bufio.NewReaderSize(io.LimitReader(f, codexMetaMax), codexMetaMax).ReadSlice('\n')
	if err != nil {
		return false
	}
	var row struct {
		Type    string `json:"type"`
		Payload struct {
			ID           string `json:"id"`
			ThreadSource string `json:"thread_source"`
		} `json:"payload"`
	}
	return json.Unmarshal(line, &row) == nil && row.Type == "session_meta" &&
		row.Payload.ID == id && row.Payload.ThreadSource == "user"
}

// codexMetas remembers codexUserThread per rollout file: session_meta is
// written once, when the thread starts.
var codexMetas = struct {
	sync.Mutex
	m map[string]bool
}{m: map[string]bool{}}

// codexUserThreadCached is codexUserThread, remembered per file (path and
// identity; Codex is only looked up where files have one).
func codexUserThreadCached(path, id, fileID string) bool {
	key := path + "\x00" + fileID
	codexMetas.Lock()
	user, ok := codexMetas.m[key]
	codexMetas.Unlock()
	if ok {
		return user
	}
	user = codexUserThread(path, id)
	codexMetas.Lock()
	if len(codexMetas.m) >= codexScansMax {
		clear(codexMetas.m)
	}
	codexMetas.m[key] = user
	codexMetas.Unlock()
	return user
}

// codexMissOnce logs, once per run, a Codex found in a pane without a
// rollout, so a Codex update that moves its files does not fail silently.
var codexMissOnce sync.Once

// codexSessionOf reads the rollout a proven Codex process holds now, so /new
// or a resume shows on the next lookup while the walk stays cached. The turn
// status is read from the rollout when withStatus is set (herdr reports its
// own).
func codexSessionOf(p claudeProc, wantID string, withStatus bool) (AgentSession, bool) {
	path, id, fileID, ok := codexRollout(p.pid, p.codexHome, wantID)
	if !ok {
		if wantID == "" {
			codexMissOnce.Do(func() {
				log.Printf("agent: codex process %d in a pane holds no single rollout of its own: "+
					"none before its first message, none in daemon mode (run it with --no-daemon), "+
					"two after /new (restart it); no Chat view for it until then", p.pid)
			})
		}
		return AgentSession{}, false
	}
	s := AgentSession{
		Agent: "codex", ID: id, Status: "unknown",
		CodexHome: p.codexHome, Rollout: path, RolloutID: fileID,
		PID: p.pid, ProcStart: p.procStart,
	}
	if withStatus {
		s.Status = codexStatusNow(path, fileID)
		s.DialogsReadOnly = true
	}
	return s, true
}

// codexScanning holds the rollouts whose first status scan runs in the
// background.
var codexScanning sync.Map

// codexStatusNow is codexStatus without waiting on a first scan: reading
// back through a long turn the first time can take longer than a snapshot
// may wait for every pane (agentLookupWait), so that scan runs in the
// background and the status is "unknown" until it is done. Later scans read
// only the rows appended since. The file must still be the one the process
// holds (fileID).
func codexStatusNow(path, fileID string) string {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() || (fileID != "" && fileIdentity(fi) != fileID) {
		return "unknown"
	}
	key := path + "\x00" + fileIdentity(fi)
	codexScans.Lock()
	_, scanned := codexScans.m[key]
	codexScans.Unlock()
	if scanned {
		return codexStatus(path)
	}
	if _, running := codexScanning.LoadOrStore(key, true); !running {
		go func() {
			defer codexScanning.Delete(key)
			codexStatus(path)
		}()
	}
	return "unknown"
}

// codexHolders caches, per session id, the Codex process found holding its
// rollout (herdr reports the id but not the pane's process).
var codexHolders = newTTLCache[claudeProcResult](agentTreeTTL)

// findCodexSession returns the session id as written by a Codex process that
// holds its rollout open, looked up among every process. herdr's Codex
// integration reports the id from a hook that runs in the app-server daemon
// when there is one, so the id can be another pane's: only a session whose
// rollout a --no-daemon TUI writes is trusted.
func findCodexSession(id string) (AgentSession, bool) {
	if !codexProcSupported || !isSessionID(id) {
		return AgentSession{}, false
	}
	r, _ := codexHolders.do(id, func() (claudeProcResult, error) {
		for _, pid := range procAllPIDs() {
			p, ok := codexProcOf(pid)
			if !ok {
				continue
			}
			if _, _, _, ok := codexRollout(pid, p.codexHome, id); ok {
				return claudeProcResult{p, true}, nil
			}
		}
		return claudeProcResult{}, nil
	})
	if !r.found || !claudeProcAlive(r.p.pid, r.p.procStart) {
		return AgentSession{}, false
	}
	return codexSessionOf(r.p, id, false)
}
