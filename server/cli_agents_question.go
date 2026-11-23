package main

import (
	"strings"
	"unicode"
)

// A turn can end with a question to the user written in the answer, not in
// a dialog: the pane is idle or done as after finished work, so wait exits 0
// either way. read and wait say so, from the transcript, for the
// orchestrator to relay the question rather than report the work done. It is
// a hint only: the job's state and wait's exit status stay as they are.

// endsWithQuestion: the agent's last word in entries is text whose last line
// ends with a question mark (a closing quote, bracket or emphasis after it
// is ignored). A user message after it, or a tool call after the text, is
// not a turn that ended on a question.
func endsWithQuestion(entries []TranscriptEntry) bool {
	for i := len(entries) - 1; i >= 0; i-- {
		switch entries[i].Role {
		case "user":
			return false
		case "assistant":
		default:
			continue
		}
		parts := entries[i].Parts
		for k := len(parts) - 1; k >= 0; k-- {
			p := parts[k]
			switch {
			case p.Kind == "thinking":
				continue
			case p.Kind == "text" && strings.TrimSpace(p.Text) == "":
				continue
			case p.Kind == "text":
				return textEndsWithQuestion(p.Text)
			}
			return false
		}
	}
	return false
}

// textEndsWithQuestion: the last line of s, without what may close a
// sentence after its mark (quotes, brackets, Markdown emphasis), ends with
// ? (ASCII or full width).
func textEndsWithQuestion(s string) bool {
	s = strings.TrimRightFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune("*_`\"')]}»”’", r)
	})
	return strings.HasSuffix(s, "?") || strings.HasSuffix(s, "？")
}

// paneEndsWithQuestion reads the transcript of paneID and reports whether
// its last turn ended with a question. A transcript the server cannot give
// is no question: the line wait prints stays the plain one.
func (c *cli) paneEndsWithQuestion(port int, paneID string) bool {
	if paneID == "" {
		return false
	}
	var t transcriptResponse
	if err := c.agentsGet(port, panePath(paneID, "/agent/transcript"), &t); err != nil {
		return false
	}
	return endsWithQuestion(t.Entries)
}
