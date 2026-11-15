package main

import (
	"context"
	"errors"
	"log"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The subagent tree of an OpenCode pane. A subagent of OpenCode runs in a
// session of its own whose parentID is the session that started it, listed
// by the service (session.list with parentID, which lists only direct
// children; checked on OpenCode 2.3.0). The tree holds the children of the
// pane's session and their children, no deeper: a subagent of 2.3.0 has no
// subagent tool, so grandchildren come only from a configuration that gives
// it one. Whether one runs is session.active, shared with the pane's status;
// its last tool and tokens come from its last few messages.

const (
	// opencodeSubagentDepth levels of subagents are read: children and
	// grandchildren of the pane's session.
	opencodeSubagentDepth = 2
	// opencodeSubagentMessages messages of a subagent are read for its last
	// tool and the tokens of its last request.
	opencodeSubagentMessages = 10
	// opencodeSubagentTimeout bounds one read of the whole tree.
	opencodeSubagentTimeout = 5 * time.Second
)

// What was read of a subagent's session (its children, its last messages)
// is kept by its id and its time of last update, so a subagent that has
// not changed is not read again; dropped when not asked for in
// subagentsKeep.
var (
	opencodeSubagentKids  = newTTLCache[opencodeKids](subagentsKeep)
	opencodeSubagentTails = newTTLCache[subagentTail](subagentsKeep)
)

type opencodeKids struct {
	kids []opencodeChild
	more bool
}

// readOpencodeSubagents builds the tree of session id. A service that does
// not run has none; one that fails is an error the client is told nothing
// of but that the tree could not be read.
func readOpencodeSubagents(id string) (subagentsResponse, error) {
	res := emptySubagents()
	c, err := opencodeConnect()
	if err != nil {
		return res, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeSubagentTimeout)
	defer cancel()
	active, err := opencodeActive.do("", func() (map[string]bool, error) {
		ctx, cancel := context.WithTimeout(ctx, opencodeTimeout)
		defer cancel()
		return c.active(ctx)
	})
	if err != nil {
		return res, opencodeSubagentError(err)
	}
	nodes, more, err := opencodeSubagentLevel(ctx, c, id, "", active, 1, subagentsMaxNodes)
	if err != nil {
		return res, opencodeSubagentError(err)
	}
	res.Nodes, res.Truncated = nodes, more
	return res, nil
}

// opencodeSubagentError logs err; the client gets no transcript, never the
// service's words.
func opencodeSubagentError(err error) error {
	if !errors.Is(err, errOpencodeUnavailable) && !errors.Is(err, errOpencodeNotFound) {
		log.Printf("opencode subagents: %v", err)
	}
	return errNoTranscript
}

// opencodeSubagentLevel lists the subagents of session id (updated at
// updated, "" for the pane's own session, which is always read), oldest
// first as Claude's tree is, at most budget of them in all levels from
// depth on.
func opencodeSubagentLevel(ctx context.Context, c *opencodeClient, id, updated string, active map[string]bool, depth, budget int) ([]subagentNode, bool, error) {
	read := func() (opencodeKids, error) {
		kids, more, err := c.children(ctx, id, budget)
		return opencodeKids{kids, more}, err
	}
	var k opencodeKids
	var err error
	if updated == "" || active[id] {
		k, err = read()
	} else {
		key := id + "\x00" + updated + "\x00" + strconv.Itoa(budget) + "\x00"
		if k, err = opencodeSubagentKids.do(key, read); err != nil {
			opencodeSubagentKids.forgetPrefix(key)
		}
	}
	if err != nil {
		return nil, false, err
	}
	// The cached list is shared: sorted as a copy.
	kids, more := slices.Clone(k.kids), k.more
	if len(kids) > budget {
		kids, more = kids[:budget], true
	}
	budget -= len(kids)
	slices.SortStableFunc(kids, func(a, b opencodeChild) int {
		if c := compareFloat(a.Time.Created, b.Time.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	nodes := []subagentNode{}
	for _, kid := range kids {
		n := opencodeSubagentNode(kid, active[kid.ID], depth)
		n.LastTool, n.Tokens = opencodeSubagentTail(ctx, c, kid, active[kid.ID])
		if depth < opencodeSubagentDepth && budget > 0 {
			children, deeper, err := opencodeSubagentLevel(ctx, c, kid.ID, opencodeUpdated(kid), active, depth+1, budget)
			if err != nil {
				// The subagents read so far are kept; theirs are left out.
				if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
					log.Printf("opencode subagents: %v", err)
				}
				children, deeper = []subagentNode{}, true
			}
			budget -= countSubagents(children)
			n.Children, more = children, more || deeper
		}
		nodes = append(nodes, n)
	}
	return nodes, more, nil
}

// opencodeSubagentNode is a subagent's node as its session tells it: the
// agent it runs as, its title (the description it was started with), and
// running while it runs a turn, else how its last turn ended.
func opencodeSubagentNode(s opencodeChild, running bool, depth int) subagentNode {
	n := subagentNode{ID: s.ID, Type: "agent", Status: "running", Depth: depth, Children: []subagentNode{}}
	if t := cutRunes(collapseSpace(s.Agent), subagentNameMax); t != "" {
		n.Type = t
	}
	n.Description = cutRunes(collapseSpace(s.Title), subagentDescMax)
	if s.Time.Created > 0 {
		n.StartTS = time.UnixMilli(int64(s.Time.Created)).UTC().Format(activityTimeFormat)
	}
	if running {
		return n
	}
	switch s.Outcome {
	case "failed":
		n.Status = "error"
	case "interrupted":
		n.Status = "stopped"
	default:
		n.Status = "done"
	}
	if s.Time.Idle > 0 {
		n.EndTS = time.UnixMilli(int64(s.Time.Idle)).UTC().Format(activityTimeFormat)
	}
	return n
}

// opencodeSubagentTail is the last tool subagent s called and the tokens of
// its last request, from its last opencodeSubagentMessages messages; nothing
// when they cannot be read. A running one is read every time.
func opencodeSubagentTail(ctx context.Context, c *opencodeClient, s opencodeChild, running bool) (string, int64) {
	key := s.ID + "\x00" + opencodeUpdated(s) + "\x00"
	if running {
		opencodeSubagentTails.forgetPrefix(key)
	}
	tail, err := opencodeSubagentTails.do(key, func() (subagentTail, error) {
		page, err := c.messages(ctx, s.ID, "", opencodeSubagentMessages)
		if errors.Is(err, errOpencodeTooLarge) {
			page, err = c.messages(ctx, s.ID, "", 1)
		}
		if err != nil {
			return subagentTail{}, err
		}
		var t subagentTail
		for _, m := range page.messages { // newest first
			if m.Type != "assistant" {
				continue
			}
			if t.tokens == 0 && m.Tokens != nil {
				t.tokens = m.Tokens.total()
			}
			for i := len(m.Content) - 1; i >= 0 && t.lastTool == ""; i-- {
				if m.Content[i].Type == "tool" && m.Content[i].Name != "" {
					t.lastTool = cutRunes(collapseSpace(m.Content[i].Name), subagentNameMax)
				}
			}
			if t.tokens > 0 && t.lastTool != "" {
				break
			}
		}
		return t, nil
	})
	if err != nil {
		opencodeSubagentTails.forgetPrefix(key)
		if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode subagents: %v", err)
		}
		return "", 0
	}
	return tail.lastTool, tail.tokens
}

// opencodeUpdated is when session s last changed, as a key.
func opencodeUpdated(s opencodeChild) string {
	return strconv.FormatFloat(s.Time.Updated, 'f', -1, 64)
}

func compareFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// countSubagents is the number of nodes in nodes and under them.
func countSubagents(nodes []subagentNode) int {
	n := len(nodes)
	for _, c := range nodes {
		n += countSubagents(c.Children)
	}
	return n
}
