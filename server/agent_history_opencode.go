package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"time"
)

// The OpenCode sessions of the history come from the user's own service
// (session.list), never from opencode.db: its root sessions (a subagent's
// session has a parent and is not listed), kept when the directory the
// service records is the pane's root or under it. The service's filter by
// directory matches one directory exactly (checked on OpenCode 2.3.0), so
// every root session is read, a page at a time, and placed by the server.

const (
	// opencodeHistoryPage is how many sessions one read of the list asks
	// for.
	opencodeHistoryPage = 100
	// opencodeHistoryTimeout bounds the whole read of the list.
	opencodeHistoryTimeout = 5 * time.Second
)

// opencodeSessionInfo is the part of a session the history reads.
type opencodeSessionInfo struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
	Title    string `json:"title"`
	Time     struct {
		Updated int64 `json:"updated"`
	} `json:"time"`
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
}

// opencodeHistoryList is every root session the service lists, newest
// first, and whether the read stopped at historyMaxScan.
type opencodeHistoryList struct {
	sessions  []opencodeSessionInfo
	truncated bool
}

// rootSessions reads the service's root sessions, newest first, at most
// max of them. The page cursor is the service's own, only ever passed back
// to it.
func (c *opencodeClient) rootSessions(ctx context.Context, max int) (opencodeHistoryList, error) {
	var list opencodeHistoryList
	cursor := ""
	for {
		limit := min(opencodeHistoryPage, max-len(list.sessions))
		if limit <= 0 {
			list.truncated = true
			return list, nil
		}
		q := url.Values{"parentID": {"null"}, "limit": {strconv.Itoa(limit)}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var res struct {
			Data   []opencodeSessionInfo `json:"data"`
			Cursor struct {
				Next *string `json:"next"`
			} `json:"cursor"`
		}
		if err := c.get(ctx, "/api/session", q, opencodeSmallMax, &res); err != nil {
			return list, err
		}
		for _, s := range res.Data {
			if s.ParentID == "" && isOpencodeSessionID(s.ID) {
				list.sessions = append(list.sessions, s)
			}
		}
		// The service gives a cursor even after the last page; a page
		// shorter than asked is the last.
		if len(res.Data) < limit || res.Cursor.Next == nil || *res.Cursor.Next == "" || len(*res.Cursor.Next) > 1024 {
			return list, nil
		}
		cursor = *res.Cursor.Next
	}
}

// scanOpencode lists root's OpenCode sessions. The service's list is read
// once for every root within historyTTL; a service that does not run or
// answer holds no session.
func (h *historyAPI) scanOpencode(root string) ([]historySession, bool) {
	list, err := h.opencode.do("", func() (opencodeHistoryList, error) {
		c, err := opencodeConnect()
		if err != nil {
			return opencodeHistoryList{}, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), opencodeHistoryTimeout)
		defer cancel()
		list, err := c.rootSessions(ctx, historyMaxScan)
		if err != nil {
			log.Printf("opencode history: %v", err)
			return opencodeHistoryList{}, nil
		}
		return list, nil
	})
	if err != nil {
		return nil, false
	}
	var out []historySession
	for _, s := range list.sessions {
		if e, ok := opencodeHistoryEntry(root, s); ok {
			out = append(out, e)
		}
	}
	return out, list.truncated
}

// opencodeHistoryEntry makes the client's row of session s when the
// directory the service records for it is root or under it. The directory
// is the service's path for the server user's own files: resolved when it
// still exists, as a Claude Code cwd is.
func opencodeHistoryEntry(root string, s opencodeSessionInfo) (historySession, bool) {
	dir := s.Location.Directory
	if dir == "" {
		return historySession{}, false
	}
	dir = filepath.Clean(dir)
	at := dir
	if real, err := evalSymlinks(dir); err == nil {
		at = real
	}
	rel, ok := relUnder(root, at)
	if !ok {
		return historySession{}, false
	}
	updated := time.UnixMilli(s.Time.Updated)
	return historySession{
		Agent: "opencode", ID: s.ID, Title: historyTitle(s.Title), TitleSource: titleAI,
		Cwd: rel, UpdatedAt: updated.UTC().Format(time.RFC3339), updated: updated, absCwd: dir,
	}, true
}

// fork makes a new session of session id's messages (all of them, copied
// by the service, so the fork's transcript needs no part of its parent) and
// returns its id.
func (c *opencodeClient) fork(ctx context.Context, id string) (string, error) {
	if !isOpencodeSessionID(id) {
		return "", errOpencodeNotFound
	}
	var res struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := c.write(ctx, http.MethodPost, "/api/session/"+id+"/fork", map[string]any{}, &res); err != nil {
		return "", err
	}
	if !isOpencodeSessionID(res.Data.ID) {
		return "", errors.New("opencode fork: no session id in the reply")
	}
	return res.Data.ID, nil
}

// opencodeForkSession forks s through the service for a resume: the
// returned session is the fork, in s's directory. The service's errors are
// logged only; the client gets session_not_found or agent_unavailable.
func opencodeForkSession(ctx context.Context, s historySession) (historySession, error) {
	c, err := opencodeConnect()
	if err != nil {
		return historySession{}, errOpencodeNoReply
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeWriteTimeout)
	defer cancel()
	id, err := c.fork(ctx, s.ID)
	if err != nil {
		log.Printf("opencode fork: %v", err)
		if errors.Is(err, errOpencodeNotFound) {
			return historySession{}, errSessionNotFound
		}
		return historySession{}, errOpencodeNoReply
	}
	s.ID = id
	return s, nil
}

// newOpencodeSessionID is the id a started OpenCode gets with --session:
// OpenCode makes the session with that id at its first message, so the
// pane has a session termote can name from the start.
func newOpencodeSessionID() string {
	return "ses_" + rand.Text()
}
