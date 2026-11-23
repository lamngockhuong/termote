package main

import (
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
)

// The subagent transcript
// (/api/mux/panes/{id}/agent/subagents/{agentId}/transcript) is one
// subagent's own conversation: agent-<agentId>.jsonl in the subagents
// directory of the pane's Claude Code session (agent_subagents.go), read like
// the session's transcript. The client sends only the id; the file is opened
// inside that directory, never by a path, and never through a link.
//
// A view-only client is refused: the task the subagent was given and the
// report it ends with are plain text in its file, where in the session's
// transcript they are the input and the result of an Agent tool call, which
// viewTranscript leaves out.

// claudeSubagentJournal reads a subagent's file: claudeJournal's rows, the
// sidechain ones kept (every row of the file is one). It has no Locate of its
// own (openClaudeSubagent opens the file) and reads no image: a subagent's
// only user message is the task, a string.
type claudeSubagentJournal struct{}

func (claudeSubagentJournal) Agent() string { return "claude" }

func (claudeSubagentJournal) Locate(AgentSession) (string, error) { return "", errNoTranscript }

func (claudeSubagentJournal) Parse(r io.Reader, start int64) ([]TranscriptEntry, int64) {
	return parseClaudeLines(r, start, true)
}

// subagentOpenHook runs between the Lstat of a subagent's file and its open;
// tests swap the file there.
var subagentOpenHook = func() {}

// openClaudeSubagent opens the file of s's subagent id with its size and
// identity. It is errSessionNotFound whenever there is no such plain file in
// the session's subagents directory: no transcript, no directory, a link at
// any level, or a file swapped between its Lstat and its open.
func openClaudeSubagent(s AgentSession, id string) (journalReader, int64, string, error) {
	root, proj, _, err := claudeSessionDir(s)
	if err != nil {
		return nil, 0, "", errSessionNotFound
	}
	dir, err := openSubagentsDir(root, proj, s.ID)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, errSubagentsLink) {
			log.Printf("subagent transcript: session %s: %v", s.ID, err)
		}
		return nil, 0, "", errSessionNotFound
	}
	defer dir.Close()
	name := "agent-" + id + ".jsonl"
	listed, err := dir.Lstat(name)
	if err != nil {
		return nil, 0, "", errSessionNotFound
	}
	subagentOpenHook()
	f, fi, ok := openPlainFile(dir, fs.FileInfoToDirEntry(listed))
	if !ok {
		return nil, 0, "", errSessionNotFound
	}
	fileID := fileIdentity(fi)
	if fileID == "" {
		fileID = name // no device and inode (Windows)
	}
	return f, fi.Size(), fileID, nil
}

func (a *agentAPI) handleSubagentTranscript(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	if isViewOnly(r) {
		writeViewOnly(w)
		return
	}
	agentID := r.PathValue("agentId")
	if !subagentIDRe.MatchString(agentID) {
		jsonErrorCode(w, "invalid_request", "invalid subagent", http.StatusBadRequest)
		return
	}
	s, err := a.session(r.PathValue("id"))
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	if s.Agent != "claude" {
		writeCoded(w, errSessionNotFound)
		return
	}
	q := r.URL.Query()
	cursor, before := q.Get("cursor"), q.Get("before")
	if _, ok := decodeCursor(cursor); !ok {
		cursor = ""
	}
	if _, ok := decodeCursor(before); before != "" && !ok {
		a.agentError(w, "subagent transcript", errInvalidBefore)
		return
	}
	res, err := a.readSubagent(s, agentID, cursor, before)
	if err != nil {
		a.agentError(w, "subagent transcript", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, res)
}

// readSubagent reads the transcript of s's subagent id as readCached does.
// The file is opened first, so an id with no file is answered without
// waiting for one of the transcriptReads slots. Its cursors name the session
// and the subagent: neither the session's transcript nor another subagent's
// takes them. Status is unknown: the client has the subagent's from the tree.
func (a *agentAPI) readSubagent(s AgentSession, id, cursor, before string) (transcriptResponse, error) {
	f, size, fileID, err := openClaudeSubagent(s, id)
	if err != nil {
		return transcriptResponse{}, err
	}
	defer f.Close()
	key := strings.Join([]string{"subagent", s.ID, s.ClaudeDir, s.Transcript, id, fileID, cursor, before}, "\x00")
	return a.reads.do(key, func() (transcriptResponse, error) {
		transcriptReads <- struct{}{}
		defer func() { <-transcriptReads }()
		res := transcriptResponse{Agent: "claude", SessionID: s.ID, Status: "unknown"}
		return readJournal(claudeSubagentJournal{}, f, size, fileID, s.ID+"/"+id, res, cursor, before)
	})
}
