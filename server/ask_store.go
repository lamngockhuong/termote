package main

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The orchestrator's questions for the user (asks), kept in the job ledger's
// file under its lock (job_store.go), so a question outlives a compacted
// conversation and keeps its id: Q1, Q2... from a counter that only grows.
// The orchestrator adds and closes them over the local socket (termote
// agents ask); the user answers one in the PWA's Plan, and the server types
// the answer into the input box of the orchestrator that asked
// (ask_routes.go), or dismisses it: nothing is typed then, and wait --mine
// tells the orchestrator once.
//
// An ask belongs to the pane of the orchestrator that added it: CreatedBy is
// that pane's activity key, as a job's is, and Agent the agent that ran
// there, which an answer from the PWA must still find there.

const (
	askOpen     = "open"
	askAnswered = "answered"
	// askDismissed: the user chose in the PWA not to answer it.
	askDismissed = "dismissed"
	// maxAskText and maxAskChoice are in runes, maxAskAnswer in bytes: an
	// answer with its fixed prefix stays far below agentMaxText.
	maxAskText    = 500
	maxAskChoices = 6
	maxAskChoice  = 80
	maxAskAnswer  = 2 << 10
	// maxOpenAsksPerPane bounds the open asks of one orchestrator,
	// maxAsks the asks of the file (answered ones make room, oldest first).
	maxOpenAsksPerPane = 20
	maxAsks            = 200
	// askBody bounds the ask routes' bodies.
	askBody = 8 << 10
)

var askIDRe = regexp.MustCompile(`^Q[1-9][0-9]{0,8}$`)

var (
	errAskNotFound = &codedError{"ask_not_found", "no such question", http.StatusNotFound}
	errTooManyAsks = &codedError{"too_many_asks", fmt.Sprintf("up to %d open questions for each pane, %d in all", maxOpenAsksPerPane, maxAsks), http.StatusConflict}
)

func invalidAsk(msg string) *codedError {
	return &codedError{"ask_invalid", msg, http.StatusBadRequest}
}

// askError is an ask that was answered or dismissed already (ask_closed)
// or changed since the client read it (ask_conflict). It carries the ask as
// it is, so the CLI can print the answer it has.
type askError struct {
	codedError
	ask ask
}

func askClosed(q ask) *askError {
	return &askError{codedError{"ask_closed", "the question was answered or dismissed already", http.StatusConflict}, q}
}

func askConflict(q ask) *askError {
	return &askError{codedError{"ask_conflict", "the question was changed elsewhere", http.StatusConflict}, q}
}

// ask is one question of an orchestrator for the user.
type ask struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Choices []string `json:"choices,omitempty"`
	// Job: a job of the same orchestrator, unfinished when the ask was added.
	Job       string   `json:"job,omitempty"`
	CreatedBy string   `json:"createdBy"`
	Agent     jobAgent `json:"agent"`
	State     string   `json:"state"`
	Answer    string   `json:"answer,omitempty"`
	// Choice: the 1-based choice an answer from the PWA picked.
	Choice int `json:"choice,omitempty"`
	// AnsweredBy: pwa (the user, through the server: an answer or a
	// dismissal) or agent (the orchestrator closed it: the user answered
	// somewhere else).
	AnsweredBy string `json:"answeredBy,omitempty"`
	// Reported: wait --mine told the orchestrator of an answer or a
	// dismissal from the PWA.
	Reported bool      `json:"reported,omitempty"`
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"`
}

func (q ask) clone() ask {
	q.Choices = slices.Clone(q.Choices)
	return q
}

func cloneAsks(list []ask) []ask {
	out := make([]ask, len(list))
	for i, q := range list {
		out[i] = q.clone()
	}
	return out
}

// askNum is n of the id Qn, or 0.
func askNum(id string) int {
	if !askIDRe.MatchString(id) {
		return 0
	}
	n, _ := strconv.Atoi(id[1:])
	return n
}

func validAskID(id string) bool { return askIDRe.MatchString(id) }

// pruneAsks drops the asks a write leaves with nothing to wait for. Once
// every job of an orchestrator is finished (one with no job yet is left
// alone), its answered and dismissed asks go, but an answer or a dismissal
// from the PWA that wait --mine has not reported yet, and its open asks of a job; an open ask of no job
// stays ("what next?" asked after the last job). An ask not changed since
// cutoff goes in any case.
func pruneAsks(f *jobFile, cutoff time.Time) {
	if len(f.Asks) == 0 {
		return
	}
	done := map[string]bool{}
	for _, j := range f.Jobs {
		fin := jobFinished(j.State)
		if prev, ok := done[j.CreatedBy]; ok {
			fin = prev && fin
		}
		done[j.CreatedBy] = fin
	}
	f.Asks = slices.DeleteFunc(f.Asks, func(q ask) bool {
		switch {
		case q.Updated.Before(cutoff):
			return true
		case !done[q.CreatedBy]:
			return false
		case q.State == askAnswered || q.State == askDismissed:
			return q.AnsweredBy != "pwa" || q.Reported
		}
		return q.Job != ""
	})
}

// asksList returns a copy of every ask, by id, and whether a newer
// version's file makes them read-only.
func (s *jobStore) asksList() ([]ask, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	out := cloneAsks(s.asks)
	slices.SortFunc(out, func(a, b ask) int { return askNum(a.ID) - askNum(b.ID) })
	return out, s.readOnly
}

// askByID returns the ask with id, as the file holds it now.
func (s *jobStore) askByID(id string) (ask, bool) {
	list, _ := s.asksList()
	i := slices.IndexFunc(list, func(q ask) bool { return q.ID == id })
	if i < 0 {
		return ask{}, false
	}
	return list[i], true
}

// addAsk adds q, open, with the next id. Its job, if any, must be an
// unfinished job of the same orchestrator, checked under the lock.
func (s *jobStore) addAsk(q ask) (ask, error) {
	err := s.changeFile(func(f *jobFile) error {
		open := 0
		for _, o := range f.Asks {
			if o.CreatedBy == q.CreatedBy && o.State == askOpen {
				open++
			}
		}
		if open >= maxOpenAsksPerPane {
			return errTooManyAsks
		}
		if q.Job != "" && !slices.ContainsFunc(f.Jobs, func(j job) bool {
			return j.ID == q.Job && j.CreatedBy == q.CreatedBy && !jobFinished(j.State)
		}) {
			return invalidAsk("no unfinished job of this pane has that id")
		}
		if len(f.Asks) >= maxAsks {
			// An answer wait --mine has reported, or that never needs
			// reporting, goes before one from the PWA not reported yet.
			at := oldestAnswered(f.Asks, true)
			if at < 0 {
				at = oldestAnswered(f.Asks, false)
			}
			if at < 0 {
				return errTooManyAsks
			}
			f.Asks = slices.Delete(f.Asks, at, at+1)
		}
		// Past every id the file holds, even one a file without a counter
		// kept: an id is never given twice.
		for _, o := range f.Asks {
			f.AskSeq = max(f.AskSeq, askNum(o.ID))
		}
		f.AskSeq++
		q.ID = "Q" + strconv.Itoa(f.AskSeq)
		q.State, q.Answer, q.Choice, q.AnsweredBy, q.Reported = askOpen, "", 0, "", false
		q.Created = s.stamp(time.Time{})
		q.Updated = q.Created
		f.Asks = append(f.Asks, q.clone())
		return nil
	})
	return q, err
}

// oldestAnswered is the index of the answered or dismissed ask changed
// longest ago (only one that needs no report with settled), or -1.
func oldestAnswered(list []ask, settled bool) int {
	at := -1
	for i, o := range list {
		if (o.State != askAnswered && o.State != askDismissed) || (settled && o.AnsweredBy == "pwa" && !o.Reported) {
			continue
		}
		if at < 0 || o.Updated.Before(list[at].Updated) {
			at = i
		}
	}
	return at
}

// changeAsk runs op on the ask with id (of the orchestrator key, unless key
// is "") and stamps it; op returning errNoChange writes nothing.
func (s *jobStore) changeAsk(id, key string, op func(q *ask) error) (ask, error) {
	var saved ask
	err := s.changeFile(func(f *jobFile) error {
		i := slices.IndexFunc(f.Asks, func(q ask) bool { return q.ID == id && (key == "" || q.CreatedBy == key) })
		if i < 0 {
			return errAskNotFound
		}
		if err := op(&f.Asks[i]); err != nil {
			saved = f.Asks[i].clone()
			return err
		}
		f.Asks[i].Updated = s.stamp(f.Asks[i].Updated)
		saved = f.Asks[i].clone()
		return nil
	})
	return saved, err
}

// closeAsk records that the user answered ask id of the orchestrator key
// somewhere else (answer may be empty). An answered or dismissed one is
// ask_closed, with its answer; one the PWA answered or dismissed counts as
// reported then: the orchestrator knows of it, wait --mine need not print it.
func (s *jobStore) closeAsk(id, key, answer string) (ask, error) {
	closed := false
	q, err := s.changeAsk(id, key, func(q *ask) error {
		if q.State != askOpen {
			if q.AnsweredBy != "pwa" || q.Reported {
				return askClosed(q.clone())
			}
			q.Reported, closed = true, true
			return nil
		}
		q.State, q.Answer, q.Choice, q.AnsweredBy = askAnswered, answer, 0, "agent"
		return nil
	})
	if err == nil && closed {
		return q, askClosed(q)
	}
	return q, err
}

// answerAsk records the user's answer from the PWA, refusing an ask
// answered or dismissed already or changed since updated.
func (s *jobStore) answerAsk(id, updated, answer string, choice int) (ask, error) {
	return s.changeAsk(id, "", func(q *ask) error {
		if q.State != askOpen {
			return askClosed(q.clone())
		}
		if q.Updated.Format(time.RFC3339Nano) != updated {
			return askConflict(q.clone())
		}
		q.State, q.Answer, q.Choice, q.AnsweredBy, q.Reported = askAnswered, answer, choice, "pwa", false
		return nil
	})
}

// dismissAsk records that the user chose in the PWA not to answer ask id,
// refusing one answered or dismissed already or changed since updated.
// wait --mine tells the orchestrator (reported, as for an answer).
func (s *jobStore) dismissAsk(id, updated string) (ask, error) {
	return s.changeAsk(id, "", func(q *ask) error {
		if q.State != askOpen {
			return askClosed(q.clone())
		}
		if q.Updated.Format(time.RFC3339Nano) != updated {
			return askConflict(q.clone())
		}
		q.State, q.Answer, q.Choice, q.AnsweredBy, q.Reported = askDismissed, "", 0, "pwa", false
		return nil
	})
}

// markAskReported records that wait --mine told the orchestrator key of
// the PWA's answer to ask id, or that the user dismissed it there.
func (s *jobStore) markAskReported(id, key string) error {
	_, err := s.changeAsk(id, key, func(q *ask) error {
		if q.AnsweredBy != "pwa" {
			return invalidAsk("only an answer or a dismissal from the PWA is reported")
		}
		if q.Reported {
			return errNoChange
		}
		q.Reported = true
		return nil
	})
	if errors.Is(err, errNoChange) {
		return nil
	}
	return err
}

// repinAsks gives the open asks of the orchestrator key its agent now: one
// that cleared its conversation or resumed another (a new session or
// process) at the same pane still gets the PWA's answers. Only an agent of
// the same kind takes them over. Nothing is written when nothing changes.
func (s *jobStore) repinAsks(key string, ag jobAgent) error {
	err := s.changeFile(func(f *jobFile) error {
		changed := false
		for i := range f.Asks {
			q := &f.Asks[i]
			if q.CreatedBy == key && q.State == askOpen && q.Agent != ag && q.Agent.Kind == ag.Kind {
				q.Agent = ag
				changed = true
			}
		}
		if !changed {
			return errNoChange
		}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return nil
	}
	return err
}

// validAskText cleans a question: line breaks kept, 1 to maxAskText runes.
func validAskText(t string) (string, error) {
	t = cleanJobText(t, true)
	switch n := utf8.RuneCountInString(t); {
	case n == 0:
		return "", invalidAsk("the question is empty")
	case n > maxAskText:
		return "", invalidAsk(fmt.Sprintf("the question is longer than %d characters", maxAskText))
	}
	return t, nil
}

// askLine is s on one line, cleaned.
func askLine(s string) string {
	return cleanJobText(strings.Join(strings.Fields(s), " "), false)
}

// validAskChoices cleans the choices: up to maxAskChoices, each one line of
// 1 to maxAskChoice runes, no two the same.
func validAskChoices(in []string) ([]string, error) {
	if len(in) > maxAskChoices {
		return nil, invalidAsk(fmt.Sprintf("up to %d choices", maxAskChoices))
	}
	var out []string
	for _, c := range in {
		c = askLine(c)
		switch n := utf8.RuneCountInString(c); {
		case n == 0:
			return nil, invalidAsk("a choice is empty")
		case n > maxAskChoice:
			return nil, invalidAsk(fmt.Sprintf("a choice is longer than %d characters", maxAskChoice))
		case slices.Contains(out, c):
			return nil, invalidAsk("two choices are the same")
		}
		out = append(out, c)
	}
	return out, nil
}

// validAskAnswer cleans an answer: line breaks and tabs kept, at most
// maxAskAnswer bytes; empty is the caller's to refuse.
func validAskAnswer(a string) (string, error) {
	a = cleanJobText(a, true)
	if len(a) > maxAskAnswer {
		return "", invalidAsk(fmt.Sprintf("the answer is larger than %d bytes", maxAskAnswer))
	}
	return a, nil
}
