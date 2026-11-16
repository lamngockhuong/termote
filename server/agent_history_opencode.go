package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
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

// opencodeSessionInfo is the part of a session the history and the usage
// read. Tokens and Cost are the session's own requests (its subagents' are
// in their sessions), Cost in USD at the prices of the user's provider.
type opencodeSessionInfo struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
	Title    string `json:"title"`
	Time     struct {
		Updated int64 `json:"updated"`
		// Busy: when its running turn started, Idle when its last one
		// ended (the files it touched read it).
		Busy int64 `json:"busy"`
		Idle int64 `json:"idle"`
	} `json:"time"`
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
	Tokens opencodeTokens `json:"tokens"`
	Cost   float64        `json:"cost"`
}

// opencodeHistoryList is every root session the service lists, newest
// first, and whether the read stopped at historyMaxScan.
type opencodeHistoryList struct {
	sessions  []opencodeSessionInfo
	truncated bool
}

// rootSessions reads the service's root sessions, newest first, at most
// max of them.
func (c *opencodeClient) rootSessions(ctx context.Context, max int) (opencodeHistoryList, error) {
	return c.listSessions(ctx, url.Values{"parentID": {"null"}}, max, nil)
}

// listSessions reads the sessions session.list gives for q, newest
// (last updated) first, at most max of them, and stops at the first one
// stop is true for. The page cursor is the service's own, only ever passed
// back to it.
func (c *opencodeClient) listSessions(ctx context.Context, q url.Values, max int, stop func(opencodeSessionInfo) bool) (opencodeHistoryList, error) {
	var list opencodeHistoryList
	cursor := ""
	for {
		limit := min(opencodeHistoryPage, max-len(list.sessions))
		if limit <= 0 {
			list.truncated = true
			return list, nil
		}
		q.Set("limit", strconv.Itoa(limit))
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
			if stop != nil && stop(s) {
				return list, nil
			}
			if (q.Get("parentID") != "null" || s.ParentID == "") && isOpencodeSessionID(s.ID) {
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
	// An absolute path; one starting with "/" is taken on Windows too (the
	// tests' recorded paths have no drive letter). A relative one would be
	// resolved against termote's own directory.
	dir := s.Location.Directory
	if !filepath.IsAbs(dir) && !strings.HasPrefix(dir, "/") {
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

const (
	// opencodeModelTTL bounds how long the model of a session is kept; a
	// session that changed has another key (its time.updated) long before.
	opencodeModelTTL = 10 * time.Minute
	// opencodeModelReads is how many sessions' models are read at once.
	opencodeModelReads = 6
)

// opencodeModelRe is a model name the history sends: provider/id as
// OpenCode names them, nothing else of the service's.
var opencodeModelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$`)

// lastModel is the model of session id's last answer (its newest assistant
// message, as session.message.list gives them), "" when it has none.
// OpenCode 2.3.0 keeps no model in the session itself (Session.Info.model
// is null).
func (c *opencodeClient) lastModel(ctx context.Context, id string) (string, error) {
	if !isOpencodeSessionID(id) {
		return "", errOpencodeNotFound
	}
	q := url.Values{"type": {"assistant"}, "limit": {"1"}, "order": {"desc"}}
	var res struct {
		Data []struct {
			Type  string           `json:"type"`
			Model opencodeModelRef `json:"model"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/api/session/"+id+"/message", q, opencodeMessagesMax, &res); err != nil {
		return "", err
	}
	if len(res.Data) == 0 || res.Data[0].Type != "assistant" || res.Data[0].Model.ID == "" {
		return "", nil
	}
	if name := opencodeModelName(res.Data[0].Model); opencodeModelRe.MatchString(name) {
		return name, nil
	}
	return "", nil
}

// opencodeHistoryModels sets the model of each OpenCode session of a page
// of the history, read through the service (opencodeModelReads at once,
// kept by session and time.updated). A model that cannot be read is left
// out; the page is sent all the same.
func (h *historyAPI) opencodeHistoryModels(ctx context.Context, sessions []historySession) {
	var todo []int
	for i, s := range sessions {
		if s.Agent == "opencode" {
			todo = append(todo, i)
		}
	}
	if len(todo) == 0 {
		return
	}
	c, err := opencodeConnect()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeTimeout)
	defer cancel()
	slots := make(chan struct{}, opencodeModelReads)
	var wg sync.WaitGroup
	for _, i := range todo {
		s := &sessions[i]
		key := s.ID + "\x00" + strconv.FormatInt(s.updated.UnixMilli(), 10)
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			model, err := h.opencodeModels.do(key, func() (string, error) { return c.lastModel(ctx, s.ID) })
			if err != nil {
				// Not kept: the next page asks again.
				h.opencodeModels.forgetFunc(func(k string) bool { return k == key })
				if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
					log.Printf("opencode history model: %v", err)
				}
				return
			}
			s.Model = model
		}()
	}
	wg.Wait()
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
