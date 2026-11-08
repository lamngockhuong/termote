package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
)

// Finding the Codex process of a pane (tmux) or of a session id (herdr). Only
// a Codex TUI run with --no-daemon writes its own rollout: by default a
// shared `codex app-server --managed-daemon` writes every pane's rollout, and
// that daemon is not under any pane but the one that started it (checked on
// Codex 0.159.3). So a process counts as Codex when its executable is named
// codex, it is not an app-server, and it holds open for writing a rollout of
// a user thread inside its own CODEX_HOME/sessions. After /new or /resume it
// holds several (checked on Codex 0.167.0): the one read is the thread it is
// on now (pickCodexRollout), refused when they cannot be told apart. The
// file read is a file the process holds, never one looked up by name.

const codexExeName = "codex"

// procWriteFilesFn is procWriteFiles; tests count the calls through it.
var procWriteFilesFn = procWriteFiles

// procFile is a file a process holds open for writing.
type procFile struct {
	path   string // as the process opened it
	id     string // rolloutIdentity of the open file, "" where unknown
	handle string // the fd (Unix) or handle value (Windows) it is open on
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

// codexCand is a rollout of a user thread a Codex process holds open for
// writing.
type codexCand struct {
	path, id, fileID string
	key              string   // path and fileID: the file
	opens            []string // the fds or handles it is open on
	mtime, size      int64    // rolloutStamp
}

// codexRollout returns the rollout of a user thread that p holds open for
// writing inside its CODEX_HOME/sessions: the one of session wantID when it
// is set, else the one of the thread it is on now (pickCodexRollout). It
// returns the resolved path, the session id from its name and its file
// identity.
func codexRollout(p claudeProc, wantID string) (path, id, fileID string, ok bool) {
	root, err := filepath.EvalSymlinks(filepath.Join(p.codexHome, "sessions"))
	if err != nil {
		return "", "", "", false
	}
	files := procWriteFilesFn(p.pid, func(name string) bool { return codexRolloutRe.MatchString(name) })
	var cands []codexCand
	for _, f := range files {
		real, err := filepath.EvalSymlinks(f.path)
		if err != nil || !pathWithin(root, real) {
			continue
		}
		m := codexRolloutRe.FindStringSubmatch(filepath.Base(real))
		if m == nil || (wantID != "" && m[1] != wantID) {
			continue
		}
		// The path must still name the file the process has open.
		fi, err := os.Stat(real)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		fid := rolloutIdentity(real, nil, fi)
		if f.id != "" && fid != f.id {
			continue
		}
		key := real + "\x00" + fid
		if i := slices.IndexFunc(cands, func(c codexCand) bool { return c.key == key }); i >= 0 {
			cands[i].opens = append(cands[i].opens, f.handle) // the same file on another fd
			continue
		}
		if !codexUserThreadCached(real, m[1], fid) {
			continue // a sub-agent's thread
		}
		var mtime, size int64
		if wantID == "" {
			mtime, size = rolloutStamp(real, fi)
		}
		cands = append(cands, codexCand{path: real, id: m[1], fileID: fid, key: key,
			opens: []string{f.handle}, mtime: mtime, size: size})
	}
	i, ok := 0, len(cands) == 1
	if wantID == "" && len(cands) > 0 {
		i, ok = codexPickActive(p, cands)
	}
	if !ok {
		return "", "", "", false
	}
	return cands[i].path, cands[i].id, cands[i].fileID, true
}

// codexSeen is what the last lookup of one Codex process saw: the file it
// picked (codexCand.key, "" for none) and the write time and size of each
// open, keyed by fd or handle and file.
type codexSeen struct {
	pid   int
	start string
	pick  string
	opens map[string][2]int64
}

// codexPicks remembers codexSeen per Codex process (pid and start time).
var codexPicks = struct {
	sync.Mutex
	m map[string]codexSeen
}{m: map[string]codexSeen{}}

// codexPickActive is pickCodexRollout with what the last lookup of p saw,
// and remembers what this one sees. A lookup by session id (finding herdr's
// holder) never gets here, so it does not move the pick.
func codexPickActive(p claudeProc, cands []codexCand) (int, bool) {
	key := strconv.Itoa(p.pid) + "\x00" + p.procStart
	codexPicks.Lock()
	defer codexPicks.Unlock()
	prev, had := codexPicks.m[key]
	i, ok := pickCodexRollout(cands, prev, had)
	// A refusal forgets the pick: until a write tells, it is no longer known.
	next := codexSeen{pid: p.pid, start: p.procStart, opens: map[string][2]int64{}}
	if ok {
		next.pick = cands[i].key
	}
	for _, c := range cands {
		for _, o := range c.opens {
			next.opens[o+"\x00"+c.key] = [2]int64{c.mtime, c.size}
		}
	}
	if !had && len(codexPicks.m) >= codexScansMax {
		// Forget the processes that are gone; all of them if none is.
		for k, v := range codexPicks.m {
			if !claudeProcAlive(v.pid, v.start) {
				delete(codexPicks.m, k)
			}
		}
		if len(codexPicks.m) >= codexScansMax {
			clear(codexPicks.m)
		}
	}
	codexPicks.m[key] = next
	return i, ok
}

// pickCodexRollout picks the rollout of the thread a Codex process is on
// among the user-thread rollouts it holds (Codex 0.167.0 keeps the old ones
// open after /new and /resume). /new opens the new thread's rollout at its
// first message; /resume opens the resumed one again on a new fd or handle,
// writing nothing until the next message. So, against the previous lookup
// of the same process: the one file on a new open wins, then the file
// written last among those written since, then the file picked before while
// it is still held. Anything else (no previous lookup, several files on new
// opens, the pick gone) cannot tell a resumed thread from the one written
// last, and a message sent from the view would reach the wrong thread: no
// file is picked until a write tells.
func pickCodexRollout(cands []codexCand, prev codexSeen, had bool) (int, bool) {
	if len(cands) == 1 {
		return 0, true
	}
	if len(cands) == 0 || !had {
		return 0, false
	}
	var fresh, written []int
	for i, c := range cands {
		isFresh, isWritten := false, false
		for _, o := range c.opens {
			st, ok := prev.opens[o+"\x00"+c.key]
			isFresh = isFresh || !ok
			isWritten = isWritten || (ok && st != [2]int64{c.mtime, c.size})
		}
		if isFresh {
			fresh = append(fresh, i)
		} else if isWritten {
			written = append(written, i)
		}
	}
	switch {
	case len(fresh) == 1:
		return fresh[0], true
	case len(fresh) > 1:
		return 0, false
	case len(written) > 0:
		return latestCodexRollout(cands, written, prev.pick)
	}
	i := slices.IndexFunc(cands, func(c codexCand) bool { return prev.pick != "" && c.key == prev.pick })
	return i, i >= 0
}

// latestCodexRollout is the candidate among idx written last; on a tie the
// one picked before, else none.
func latestCodexRollout(cands []codexCand, idx []int, pick string) (int, bool) {
	best, tie := idx[0], false
	for _, i := range idx[1:] {
		switch {
		case cands[i].mtime > cands[best].mtime:
			best, tie = i, false
		case cands[i].mtime == cands[best].mtime:
			tie = true
		}
	}
	if !tie {
		return best, true
	}
	for _, i := range idx {
		if cands[i].mtime == cands[best].mtime && pick != "" && cands[i].key == pick {
			return i, true
		}
	}
	return 0, false
}

// codexMetaMax caps the first line read: session_meta can carry the model's
// base instructions.
const codexMetaMax = 1 << 20

// codexUserThread reports whether the rollout's session_meta (its first
// line) is of thread id started by the user. The file opened must be the
// regular file of identity fileID (when known) that was found at path: it
// can be replaced in between.
func codexUserThread(path, id, fileID string) bool {
	f, err := os.OpenFile(path, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || (fileID != "" && rolloutIdentity(path, f, fi) != fileID) {
		return false
	}
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
	user = codexUserThread(path, id, fileID)
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
	path, id, fileID, ok := codexRollout(p, wantID)
	if !ok {
		if wantID == "" {
			codexMissOnce.Do(func() {
				log.Printf("agent: codex process %d in a pane holds no rollout of its own it can be told is the current one: "+
					"none before its first message, none in daemon mode (run it with --no-daemon), "+
					"or several written at the same time; no Chat view for it until then", p.pid)
			})
		}
		return AgentSession{}, false
	}
	return codexSessionAt(p, path, id, fileID, withStatus), true
}

// codexSessionAt is the session of rollout path that Codex process p holds.
func codexSessionAt(p claudeProc, path, id, fileID string, withStatus bool) AgentSession {
	s := AgentSession{
		Agent: "codex", ID: id, Status: "unknown",
		CodexHome: p.codexHome, Rollout: path, RolloutID: fileID,
		PID: p.pid, ProcStart: p.procStart,
	}
	if withStatus {
		s.Status = codexStatusNow(path, fileID)
		s.DialogsReadOnly = true
	}
	return s
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
	if err != nil || !fi.Mode().IsRegular() {
		return "unknown"
	}
	fid := rolloutIdentity(path, nil, fi)
	if fileID != "" && fid != fileID {
		return "unknown"
	}
	key := path + "\x00" + fid
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

// findCodexSession returns the session of the Codex process that holds
// session id's rollout open, looked up among every process. herdr's Codex
// integration reports the id from a hook that runs in the app-server daemon
// when there is one, so the id can be another pane's: only a session whose
// rollout a --no-daemon TUI writes is trusted. The hook reports a thread the
// TUI went to with /new or /resume only at its first message (Herdr 0.9.5,
// Codex 0.167.0), so the thread that process is on now is shown, and the id
// as reported only when the process's rollouts cannot be told apart.
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
			if _, _, _, ok := codexRollout(p, id); ok {
				return claudeProcResult{p, true}, nil
			}
		}
		return claudeProcResult{}, nil
	})
	if !r.found || !claudeProcAlive(r.p.pid, r.p.procStart) {
		return AgentSession{}, false
	}
	if path, sid, fileID, ok := codexRollout(r.p, ""); ok {
		return codexSessionAt(r.p, path, sid, fileID, false), true
	}
	return codexSessionOf(r.p, id, false)
}
