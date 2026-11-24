package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"text/tabwriter"
	"time"
)

// termote agents ask: the orchestrator's questions for the user, kept by
// the server (ask_store.go) so the list of what waits on the user survives a
// compacted conversation and keeps its ids. Every ask command names this
// command's own pane, the orchestrator's, which the server looks up and
// gives its open questions (so they still get the PWA's answers after a
// /clear); a pane the environment does not name for sure is refused.

const (
	askAddUsage   = "usage: termote agents ask add --text <question | -> [--choice <choice>]... [--job <id>] [--json]"
	askListUsage  = "usage: termote agents ask list [--all] [--json]"
	askCloseUsage = "usage: termote agents ask close <Qn> [--answer <answer>]"
)

// askBusyTries, askBusyEvery: how often close tries again while an answer
// from the PWA is on its way.
var (
	askBusyTries = 10
	askBusyEvery = 500 * time.Millisecond
)

// askNoSelf refuses an ask command whose pane is not known for sure.
const askNoSelf = "ask needs to know this command's pane, and its environment does not say for sure (herdr-core, psmux, Windows, or another pane's variables); ask the user in the conversation instead"

type asksListing struct {
	Asks     []askView `json:"asks"`
	ReadOnly bool      `json:"readOnly"`
}

func (c *cli) agentsAsk(args []string) error {
	if len(args) == 0 {
		return usageError("agents ask needs add, list or close\n%s\n%s\n%s", askAddUsage, askListUsage, askCloseUsage)
	}
	switch args[0] {
	case "add":
		return c.agentsAskAdd(args[1:])
	case "list", "ls":
		return c.agentsAskList(args[1:])
	case "close":
		return c.agentsAskClose(args[1:])
	}
	return usageError("unknown agents ask command: %s\n%s\n%s\n%s", args[0], askAddUsage, askListUsage, askCloseUsage)
}

// askSelf is the port, and the id and activity key of this command's pane.
func (c *cli) askSelf() (port int, pane, key string, err error) {
	if port, err = c.agentsPort(); err != nil {
		return 0, "", "", err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return 0, "", "", err
	}
	if pane = c.selfPaneID(s); pane == "" {
		return 0, "", "", errors.New(askNoSelf)
	}
	// The server looks up the agent: a pane running none is refused there.
	p, _ := findAgentPane(s, pane)
	return port, pane, p.key(), nil
}

func (c *cli) agentsAskAdd(args []string) error {
	var text, job string
	var choices []string
	asJSON := false
	fs := c.newFlagSet("agents ask add")
	fs.StringVar(&text, "text", "", "")
	fs.Func("choice", "", func(s string) error { choices = append(choices, s); return nil })
	fs.StringVar(&job, "job", "", "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 0 {
		return usageError("ask add takes no arguments; the question goes in --text\n%s", askAddUsage)
	}
	if text, err = c.readText(text); err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		return usageError("ask add needs --text <question>\n%s", askAddUsage)
	}
	port, pane, _, err := c.askSelf()
	if err != nil {
		return err
	}
	body := map[string]any{"pane": pane, "text": text, "choices": choices, "job": job}
	r, err := c.agentsCall(port, http.MethodPost, "/api/mux/asks", body, agentsReadTimeout)
	if err != nil {
		return err
	}
	if r.status != http.StatusCreated {
		return agentsRefusal(r)
	}
	q, err := askReply(r)
	if err != nil {
		return err
	}
	if asJSON {
		return writeJSON(c.out, map[string]any{"ask": q})
	}
	fmt.Fprintln(c.out, plainText(q.ID))
	return nil
}

// askReply reads the ask of a write's answer.
func askReply(r agentsReply) (askView, error) {
	var out struct {
		Ask askView `json:"ask"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || out.Ask.ID == "" {
		return askView{}, fmt.Errorf("unexpected answer from the server to the question")
	}
	return out.Ask, nil
}

func (c *cli) agentsAskList(args []string) error {
	all, asJSON := false, false
	fs := c.newFlagSet("agents ask list")
	fs.BoolVar(&all, "all", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 0 {
		return usageError("ask list takes no arguments\n%s", askListUsage)
	}
	port, pane, key, err := c.askSelf()
	if err != nil {
		return err
	}
	var l asksListing
	if err := c.agentsGet(port, "/api/mux/asks?pane="+url.QueryEscape(pane), &l); err != nil {
		return err
	}
	list := slices.DeleteFunc(l.Asks, func(q askView) bool {
		return q.CreatedBy != key || (!all && q.State != askOpen)
	})
	if asJSON {
		if list == nil {
			list = []askView{}
		}
		return writeJSON(c.out, map[string]any{"asks": list})
	}
	if len(list) == 0 {
		if all {
			fmt.Fprintln(c.out, "No questions.")
		} else {
			fmt.Fprintln(c.out, "No open questions.")
		}
		return nil
	}
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	for _, q := range list {
		job := "-"
		if q.Job != "" {
			job = plainText(q.Job)
			if q.JobTitle != "" {
				job = clipLine(q.JobTitle, 40)
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", plainText(q.ID), job, clipLine(q.Text, 200))
		if len(q.Choices) > 0 {
			var cs []string
			for i, ch := range q.Choices {
				cs = append(cs, fmt.Sprintf("%d) %s", i+1, clipLine(ch, maxAskChoice)))
			}
			fmt.Fprintf(tw, "\t\t%s\n", strings.Join(cs, "  "))
		}
		if q.State == askAnswered {
			fmt.Fprintf(tw, "\t\tanswered (%s): %s\n", plainText(q.AnsweredBy), dash(clipLine(q.Answer, 200)))
		}
	}
	return tw.Flush()
}

func (c *cli) agentsAskClose(args []string) error {
	var answer string
	fs := c.newFlagSet("agents ask close")
	fs.StringVar(&answer, "answer", "", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 || !validAskID(pos[0]) {
		return usageError("ask close needs one question id, as Q3\n%s", askCloseUsage)
	}
	id := pos[0]
	port, pane, _, err := c.askSelf()
	if err != nil {
		return err
	}
	// ask_busy: an answer from the PWA is being typed and recorded, a
	// moment; the skill closes every answer as it arrives.
	var r agentsReply
	for try := 0; ; try++ {
		if r, err = c.agentsCall(port, http.MethodPost, "/api/mux/asks/"+id+"/close", map[string]any{"pane": pane, "answer": answer}, agentsReadTimeout); err != nil {
			return err
		}
		if r.status != http.StatusConflict || r.failure().Code != "ask_busy" || try >= askBusyTries {
			break
		}
		time.Sleep(askBusyEvery)
	}
	switch {
	case r.status == http.StatusOK:
		c.infof("Closed %s", id)
		return nil
	case r.status == http.StatusConflict && r.failure().Code == "ask_closed":
		// Closing again is no error: the skill closes every answer it gets.
		if q, err := askReply(r); err == nil {
			fmt.Fprintf(c.out, "%s was already answered (%s): %s\n", id, plainText(q.AnsweredBy), dash(clipLine(q.Answer, 300)))
			return nil
		}
	}
	return agentsRefusal(r)
}

// mineAsks reads the questions of the orchestrator key: the PWA's answers
// wait --mine has not reported yet, and the ids of the open ones. A server
// that keeps no questions (an older one) has none.
func (c *cli) mineAsks(port int, key string) (answers []askView, open []string) {
	var l asksListing
	if err := c.agentsGet(port, "/api/mux/asks", &l); err != nil {
		return nil, nil
	}
	for _, q := range l.Asks {
		switch {
		case q.CreatedBy != key:
		case q.State == askOpen:
			open = append(open, q.ID)
		case q.AnsweredBy == "pwa" && !q.Reported:
			answers = append(answers, q)
		}
	}
	return answers, open
}

// reportAskAnswers prints each answer the user gave in the PWA and marks it
// reported, so the next wait does not print it again.
func (c *cli) reportAskAnswers(port int, pane string, answers []askView) {
	for _, q := range answers {
		fmt.Fprintf(c.out, "%s answered in the PWA: %s\n", plainText(q.ID), dash(clipLine(q.Answer, 300)))
		r, err := c.agentsCall(port, http.MethodPost, "/api/mux/asks/"+q.ID+"/reported", map[string]any{"pane": pane}, agentsReadTimeout)
		if err == nil && r.status != http.StatusOK {
			err = agentsRefusal(r)
		}
		if err != nil {
			fmt.Fprintf(c.errOut, "%s %s may be reported again: %v\n", c.paint(ansiYellow, "[WARN]"), plainText(q.ID), err)
		}
	}
}

// openAsksLine names the questions still open, for a wait that ends with
// none answered.
func (c *cli) openAsksLine(open []string) {
	if len(open) > 0 {
		fmt.Fprintf(c.out, "open: %s\n", strings.Join(open, " "))
	}
}

// askHints are the open questions of job j, and those the user wrote in
// its pane about after they were asked: a message of the user in entries
// later than the question and than the orchestrator's last send to the
// job (which is a message of the user in the agent's transcript too). Only
// times and roles are compared, never text; an entry without a time counts
// for nothing.
func (c *cli) askHints(port int, j jobView, entries []TranscriptEntry) (open, wrote []string) {
	var l asksListing
	if err := c.agentsGet(port, "/api/mux/asks", &l); err != nil {
		return nil, nil
	}
	// What termote or the orchestrator typed into the pane is a message of
	// the user in the agent's transcript too: a send, a start's prompt, a
	// continued worktree, the failed checks sent.
	typed := map[string]bool{"sent": true, "started": true, "continued": true, "ci_sent": true}
	var sent time.Time
	for _, e := range j.Events {
		if t, err := time.Parse(time.RFC3339Nano, e.At); typed[e.Kind] && err == nil && t.After(sent) {
			sent = t
		}
	}
	for _, q := range l.Asks {
		if q.Job != j.ID || q.State != askOpen {
			continue
		}
		open = append(open, q.ID)
		since := q.Created
		if sent.After(since) {
			since = sent
		}
		if slices.ContainsFunc(entries, func(e TranscriptEntry) bool {
			t, err := time.Parse(time.RFC3339Nano, e.TS)
			return e.Role == "user" && err == nil && t.After(since)
		}) {
			wrote = append(wrote, q.ID)
		}
	}
	return open, wrote
}
