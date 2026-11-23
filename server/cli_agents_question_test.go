package main

import "testing"

func TestEndsWithQuestion(t *testing.T) {
	text := func(s string) TranscriptPart { return TranscriptPart{Kind: "text", Text: s} }
	asst := func(parts ...TranscriptPart) TranscriptEntry { return TranscriptEntry{Role: "assistant", Parts: parts} }
	user := TranscriptEntry{Role: "user", Parts: []TranscriptPart{text("go on?")}}
	tool := TranscriptPart{Kind: "tool", Tool: "Bash", Input: "ls"}
	for name, c := range map[string]struct {
		entries []TranscriptEntry
		want    bool
	}{
		"question":            {[]TranscriptEntry{user, asst(text("Done.\n\nShall I push it?"))}, true},
		"full width":          {[]TranscriptEntry{asst(text("これでいいですか？"))}, true},
		"closed by emphasis":  {[]TranscriptEntry{asst(text("**Do you want a test too?**\n"))}, true},
		"closed by quote":     {[]TranscriptEntry{asst(text(`Want me to rename it to "parse()?"`))}, true},
		"thinking after":      {[]TranscriptEntry{asst(text("Push it?"), TranscriptPart{Kind: "thinking", Text: "wait."}, text("  "))}, true},
		"note after":          {[]TranscriptEntry{asst(text("Push it?")), {Role: "note"}}, true},
		"empty entry after":   {[]TranscriptEntry{asst(text("Push it?")), asst()}, true},
		"statement":           {[]TranscriptEntry{user, asst(text("Done, fixed."))}, false},
		"question earlier":    {[]TranscriptEntry{asst(text("Why did it fail? The lexer skipped a byte. Fixed."))}, false},
		"tool after the text": {[]TranscriptEntry{asst(text("Shall I run it?"), tool)}, false},
		"user after":          {[]TranscriptEntry{asst(text("Push it?")), user}, false},
		"nothing":             {nil, false},
	} {
		if got := endsWithQuestion(c.entries); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}
