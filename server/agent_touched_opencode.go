package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"
	"time"
)

// The files an OpenCode session changed through its own tool calls, read
// from the user's service (never opencode.db) as the Chat view reads its
// messages: the file tools of its assistant messages that completed, or
// still run (the route keeps those only for the pane's live session). A
// call that failed, or that the user declined (an error too), is not
// counted; nor is a file changed by a shell command, nor session.diff,
// which compares snapshots and so holds the user's own changes as well.
// Checked on OpenCode 2.3.0:
//
//   - edit and write name their file by path, relative to the session's
//     directory or absolute (filePath is what OpenCode also reads);
//   - patch (apply_patch is the old name OpenCode reads as patch, offered
//     instead of edit and write to gpt- models) names its files only in its
//     patch text, by "*** Add File:", "*** Update File:" (with "*** Move to:"
//     after it) and "*** Delete File:" lines: its metadata loses a moved
//     file's old path;
//   - a subagent's calls are in its own session (parentID), read level by
//     level as the subagent tree reads them; a fork copies its parent's
//     messages under ids ending in _<n>, which are not the fork's changes.
//
// A tool of another name is skipped: a renamed one leaves the list short,
// never wrong. A service that does not run has no list.

// opencodeTouchTools are the tools that change a file.
var opencodeTouchTools = map[string]bool{"edit": true, "write": true, "patch": true, "apply_patch": true}

const (
	// opencodeTouchedMaxMessages bounds the assistant messages of one
	// session read, the newest first.
	opencodeTouchedMaxMessages = 5000
	// opencodeTouchedTimeout bounds one read of a session's files.
	opencodeTouchedTimeout = 10 * time.Second
)

// opencodeTouchedReads keeps an idle session's files by its id and its time
// of last update. A running one is read every time: a tool call it starts
// does not change that time.
var opencodeTouchedReads = newTTLCache[[]touchedFile](opencodeUsageKeep)

// opencodeTouchMessage is the part of an assistant message the touched
// files read. A tool's input is decoded per tool, loosely.
type opencodeTouchMessage struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Time struct {
		Created float64 `json:"created"`
	} `json:"time"`
	Content []struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		State struct {
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input"`
		} `json:"state"`
		Time struct {
			Created   float64 `json:"created"`
			Completed float64 `json:"completed"`
		} `json:"time"`
	} `json:"content"`
}

// opencodeTouchChange is one file a tool call changes.
type opencodeTouchChange struct {
	abs string
	op  touchedOp
}

// opencodeToolChanges is what a call of tool with input changes, its paths
// made absolute against cwd; none for an input it cannot read.
func opencodeToolChanges(tool string, input json.RawMessage, cwd string) []opencodeTouchChange {
	var in map[string]json.RawMessage
	if json.Unmarshal(input, &in) != nil {
		return nil
	}
	str := func(k string) string {
		var s string
		if json.Unmarshal(in[k], &s) != nil {
			return ""
		}
		return s
	}
	one := func(op touchedOp) []opencodeTouchChange {
		if abs := touchedPath(cmp.Or(str("path"), str("filePath")), cwd); abs != "" {
			return []opencodeTouchChange{{abs, op}}
		}
		return nil
	}
	switch tool {
	case "edit":
		return one(touchedEdit)
	case "write":
		return one(touchedWrite)
	default: // patch, apply_patch
		return opencodePatchChanges(str("patchText"), cwd)
	}
}

// opencodePatchChanges is what a patch text changes: an added file is
// written, an updated one edited, a deleted one deleted; an updated one
// moved is deleted and its new path moved to.
func opencodePatchChanges(text, cwd string) []opencodeTouchChange {
	var out []opencodeTouchChange
	update := -1 // the latest updated file's change, which a move follows
	for line := range strings.Lines(text) {
		// A header starts its line: a hunk's context line starts with a
		// space, and its text may look like a header.
		line = strings.TrimRight(line, " \t\r\n")
		var op touchedOp
		var p string
		switch {
		case strings.HasPrefix(line, "*** Add File:"):
			op, p = touchedWrite, strings.TrimPrefix(line, "*** Add File:")
		case strings.HasPrefix(line, "*** Update File:"):
			op, p = touchedEdit, strings.TrimPrefix(line, "*** Update File:")
		case strings.HasPrefix(line, "*** Delete File:"):
			op, p = touchedDelete, strings.TrimPrefix(line, "*** Delete File:")
		case strings.HasPrefix(line, "*** Move to:"):
			dst := touchedPath(strings.TrimSpace(strings.TrimPrefix(line, "*** Move to:")), cwd)
			if update >= 0 && dst != "" {
				out[update].op = touchedDelete
				out = append(out, opencodeTouchChange{dst, touchedMove})
			}
			update = -1
			continue
		default:
			continue
		}
		update = -1
		abs := touchedPath(strings.TrimSpace(p), cwd)
		if abs == "" {
			continue
		}
		if op == touchedEdit {
			update = len(out)
		}
		out = append(out, opencodeTouchChange{abs, op})
	}
	return out
}

// opencodeMillis is a time the service gives in milliseconds.
func opencodeMillis(ms float64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(int64(ms))
}

// stepOpencodeTouched adds the file tool calls of message m to st.
func stepOpencodeTouched(st *touchedState, m opencodeTouchMessage) {
	if m.Type != "assistant" || !opencodeMessageIDRe.MatchString(m.ID) ||
		strings.Contains(strings.TrimPrefix(m.ID, "msg_"), "_") {
		return
	}
	for _, c := range m.Content {
		if c.Type != "tool" || !opencodeTouchTools[c.Name] {
			continue
		}
		running := c.State.Status == "running"
		if !running && c.State.Status != "completed" {
			continue
		}
		at := opencodeMillis(cmp.Or(c.Time.Completed, c.Time.Created, m.Time.Created))
		for _, ch := range opencodeToolChanges(c.Name, c.State.Input, st.cwd) {
			k := touchKey{abs: ch.abs}
			if running {
				st.wait(m.ID+"\x00"+c.ID+"\x00"+ch.abs, touchedPending{key: k, op: ch.op, at: at})
				continue
			}
			st.done(k, ch.op, at)
		}
	}
}

// opencodeIdle: a session whose last turn ended after its running one
// started. One that never ran a turn, or a service that gives neither time,
// is not taken as idle.
func opencodeIdle(busy, idle int64) bool { return idle > 0 && idle >= busy }

// opencodeTouchedOf is what session id, in dir, changed: as a subagent's
// files when sub. An idle one is kept until it is updated or ends a turn
// again (idleAt, its time.idle).
func opencodeTouchedOf(ctx context.Context, c *opencodeClient, id, dir string, updated, idleAt int64, idle, sub bool) ([]touchedFile, error) {
	read := func() ([]touchedFile, error) {
		st := newTouchedState()
		st.cwd = dir
		_, err := opencodeAssistantMessages(ctx, c, id, opencodeTouchedMaxMessages, nil,
			func(m opencodeTouchMessage) { stepOpencodeTouched(&st, m) })
		if err != nil {
			return nil, err
		}
		return st.list(sub), nil
	}
	if !idle {
		return read()
	}
	key := strings.Join([]string{id, strconv.FormatInt(updated, 10), strconv.FormatInt(idleAt, 10), dir,
		strconv.FormatBool(sub)}, "\x00")
	files, err := opencodeTouchedReads.do(key, read)
	if err != nil {
		opencodeTouchedReads.forgetFunc(func(k string) bool { return k == key })
	}
	return files, err
}

// opencodeSessionTouched is what session s and its subagents changed. A
// session not made yet (a TUI started with --session waits for its first
// message) changed nothing; a service that does not run has no transcript.
// An error of the service is never handed on with its text: the client's
// errors hold only the route and the status.
func opencodeSessionTouched(s AgentSession) ([]touchedFile, error) {
	c, err := opencodeConnect()
	if err != nil {
		return nil, errNoTranscript
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeTouchedTimeout)
	defer cancel()
	info, err := c.session(ctx, s.ID)
	if err == nil {
		var own []touchedFile
		own, err = opencodeTouchedOf(ctx, c, s.ID, info.Location.Directory, info.Time.Updated, info.Time.Idle,
			opencodeIdle(info.Time.Busy, info.Time.Idle), false)
		if err == nil {
			budget := subagentsMaxNodes
			lists := append([][]touchedFile{own},
				opencodeSubagentTouched(ctx, c, s.ID, info.Location.Directory, 1, &budget)...)
			return touchedOf(lists), nil
		}
	}
	switch {
	case errors.Is(err, errOpencodeNotFound):
		return nil, nil
	case errors.Is(err, errOpencodeUnavailable):
		return nil, errNoTranscript
	}
	return nil, err
}

// opencodeSubagentTouched is what session id's subagents changed, and
// theirs down to opencodeSubagentDepth; one that cannot be read is left
// out, and none is asked for once the read's time is up.
func opencodeSubagentTouched(ctx context.Context, c *opencodeClient, id, dir string, depth int, budget *int) [][]touchedFile {
	if *budget <= 0 || ctx.Err() != nil {
		return nil
	}
	kids, _, err := c.children(ctx, id, *budget)
	if err != nil {
		opencodeTouchedLog(err)
		return nil
	}
	*budget -= len(kids)
	var out [][]touchedFile
	for _, k := range kids {
		if ctx.Err() != nil {
			break
		}
		kdir := cmp.Or(k.Location.Directory, dir)
		files, err := opencodeTouchedOf(ctx, c, k.ID, kdir, int64(k.Time.Updated), int64(k.Time.Idle),
			opencodeIdle(int64(k.Time.Busy), int64(k.Time.Idle)), true)
		if err != nil {
			opencodeTouchedLog(err)
		} else {
			out = append(out, files)
		}
		if depth < opencodeSubagentDepth {
			out = append(out, opencodeSubagentTouched(ctx, c, k.ID, kdir, depth+1, budget)...)
		}
	}
	return out
}

func opencodeTouchedLog(err error) {
	if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
		log.Printf("opencode touched: %v", err)
	}
}
