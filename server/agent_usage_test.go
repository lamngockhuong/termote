package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// claudeAssistantRow is an assistant row of message id with usage; extra
// fields of usage go in as given.
func claudeAssistantRow(id, model, ts string, usage map[string]any) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": "u-" + id + ts, "timestamp": ts,
		"message": map[string]any{"id": id, "model": model, "role": "assistant",
			"content": []any{map[string]any{"type": "text", "text": "ok"}}, "usage": usage}})
	return string(b)
}

// readUsage writes body to a file and reads its records with a new reader.
func readUsage(t *testing.T, agent, body string) []usageRecord {
	t.Helper()
	p := filepath.Join(t.TempDir(), "j.jsonl")
	writeFile(t, p, body)
	return readUsageFile(t, newUsageReader(), agent, p)
}

func readUsageFile(t *testing.T, u *usageReader, agent, p string) []usageRecord {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	return u.records(agent, p, f, fi)
}

func TestClaudeUsageRecords(t *testing.T) {
	u1 := map[string]any{"input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 300,
		"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200},
		"output_tokens":  50, "output_tokens_details": map[string]any{"thinking_tokens": 20}}
	// No split of the cache write: 5 minutes.
	u2 := map[string]any{"input_tokens": 5, "cache_creation_input_tokens": 40, "output_tokens": 7}
	body := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"hi \"usage\""}}`,
		// One message, three blocks: one request.
		claudeAssistantRow("msg_1", "claude-opus-5-5", "2026-11-10T10:00:00Z", u1),
		claudeAssistantRow("msg_1", "claude-opus-5-5", "2026-11-10T10:00:01Z", u1),
		claudeAssistantRow("msg_1", "claude-opus-5-5", "2026-11-10T10:00:02Z", u1),
		claudeAssistantRow("msg_2", "claude-haiku-5-5", "2026-11-10T10:20:00Z", u2),
		// Claude Code's own rows cost nothing.
		claudeAssistantRow("msg_3", "<synthetic>", "2026-11-10T10:21:00Z", u2),
		// No message id: the row's uuid.
		claudeAssistantRow("", "claude-opus-5-5", "2026-11-10T10:22:00Z", u2),
		// Unreadable: no time, no model, no usage, not JSON.
		claudeAssistantRow("msg_4", "claude-opus-5-5", "yesterday", u2),
		claudeAssistantRow("msg_5", "", "2026-11-10T10:23:00Z", u2),
		`{"type":"assistant","message":{"id":"msg_6","model":"m"},"usage":1}`,
		`{"usage": nope`,
	}, "\n") + "\n"
	recs := readUsage(t, "claude", body)
	if len(recs) != 3 {
		t.Fatalf("records = %+v", recs)
	}
	r := recs[0]
	if r.key != "msg_1" || r.input != 10 || r.cacheRead != 1000 || r.cacheWrite5m != 100 || r.cacheWrite1h != 200 ||
		r.output != 50 || r.reasoning != 20 || r.model != "claude-opus-5-5" || !r.at.Equal(time.Date(2026, 11, 10, 10, 0, 2, 0, time.UTC)) {
		t.Errorf("multi-block message = %+v", r)
	}
	if r := recs[1]; r.cacheWrite5m != 40 || r.cacheWrite1h != 0 || r.output != 7 {
		t.Errorf("no cache split = %+v", r)
	}
	if r := recs[2]; !strings.HasPrefix(r.key, "row:") {
		t.Errorf("no message id = %+v", r)
	}
}

func TestCodexUsageSubagentRollout(t *testing.T) {
	b, err := os.ReadFile("testdata/usage/codex-subagent-rollout.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	recs := readUsage(t, "codex", string(b))
	// The parent's rows (copied before the start ordinal, or its thread
	// after) are left out; a response repeated counts once.
	if len(recs) != 2 {
		t.Fatalf("records = %+v", recs)
	}
	if r := recs[0]; r.key != "resp_child_1" || r.model != "gpt-5.6-luna" || r.input != 1500 || r.cacheRead != 500 || r.output != 200 || r.reasoning != 20 {
		t.Errorf("first = %+v", r)
	}
	if r := recs[1]; r.key != "resp_child_2" || r.input != 2000 || r.cacheRead != 1000 || r.output != 300 {
		t.Errorf("second = %+v", r)
	}
}

func TestCodexUsageUserFork(t *testing.T) {
	// A rollout Codex 0.169 wrote for `codex exec fork`: nothing of the
	// parent is copied, but token_count's total goes on from the parent's.
	b, err := os.ReadFile("testdata/usage/codex-user-fork-rollout.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	recs := readUsage(t, "codex", string(b))
	if len(recs) != 2 || recs[0].key != "743a908f" || recs[1].key != "99035dc2" {
		t.Fatalf("records = %+v", recs)
	}
	var in int64
	for _, r := range recs {
		in += r.input + r.cacheRead + r.cacheWrite5m
	}
	if in != 22166+22266 {
		t.Errorf("input = %d, want the fork's own two responses", in)
	}
	// The same fork from before token_usage_record: its first total holds
	// the parent's, so it is only the base.
	var legacy []string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if !strings.Contains(l, `"token_usage_record"`) {
			legacy = append(legacy, l)
		}
	}
	recs = readUsage(t, "codex", strings.Join(legacy, "\n")+"\n")
	if len(recs) != 1 || recs[0].input+recs[0].cacheRead != 88581-66315 {
		t.Errorf("legacy fork = %+v", recs)
	}
}

func TestCodexUsageLegacyRollout(t *testing.T) {
	b, err := os.ReadFile("testdata/usage/codex-legacy-rollout.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	recs := readUsage(t, "codex", string(b))
	// The first total, the difference to the next new one (the same total
	// again is a rate limit update), none at the total that went down, then
	// the difference from it.
	want := []struct{ input, read, out int64 }{{800, 200, 50}, {1000, 500, 100}, {400, 100, 30}}
	if len(recs) != len(want) {
		t.Fatalf("records = %+v", recs)
	}
	for i, w := range want {
		if r := recs[i]; r.input != w.input || r.cacheRead != w.read || r.output != w.out || r.model != "gpt-5.5" {
			t.Errorf("record %d = %+v, want %+v", i, r, w)
		}
	}
}

func TestCodexUsageMixedAndBroken(t *testing.T) {
	id := "01a00000-0000-7000-8000-00000000cccc"
	meta := `{"type":"session_meta","payload":{"id":"` + id + `"}}`
	count := func(ts string, in, out int) string {
		b, _ := json.Marshal(map[string]any{"timestamp": ts, "type": "event_msg", "payload": map[string]any{"type": "token_count",
			"info": map[string]any{"total_token_usage": map[string]any{"input_tokens": in, "output_tokens": out}}}})
		return string(b)
	}
	record := func(ts, resp string, in, write, out int) string {
		b, _ := json.Marshal(map[string]any{"timestamp": ts, "type": "token_usage_record", "payload": map[string]any{
			"thread_id": id, "response_id": resp, "usage": map[string]any{"input_tokens": in, "cache_write_input_tokens": write, "output_tokens": out}}})
		return string(b)
	}
	body := strings.Join([]string{
		// Before the session_meta: whose thread is unknown.
		count("2026-11-10T07:00:00Z", 5, 5),
		meta,
		`{"type":"session_meta","payload":{"id":"01a00000-0000-7000-8000-00000000dddd"}}`,
		`{"type":"turn_context","payload":{"model":""}}`,
		count("2026-11-10T08:00:00Z", 100, 10),
		count("bad time", 200, 20),
		// From Codex 0.165 on, the records count and the totals do not.
		record("2026-11-10T08:05:00Z", "r1", 300, 100, 30),
		count("2026-11-10T08:05:01Z", 400, 40),
		record("2026-11-10T08:06:00Z", "", 1, 0, 1),
		`{"type":"token_usage_record","payload":{"thread_id":"` + id + `","response_id":"r2"},"timestamp":"2026-11-10T08:07:00Z"}`,
		`not json`,
	}, "\n") + "\n"
	recs := readUsage(t, "codex", body)
	if len(recs) != 2 || recs[0].input != 100 || recs[0].output != 10 || recs[0].model != "" {
		t.Fatalf("records = %+v", recs)
	}
	// The cache write is part of input_tokens, priced on its own.
	if r := recs[1]; r.key != "r1" || r.input != 200 || r.cacheWrite5m != 100 || r.output != 30 {
		t.Errorf("record = %+v", r)
	}
}

func TestUsageReaderIncremental(t *testing.T) {
	u := newUsageReader()
	p := filepath.Join(t.TempDir(), "j.jsonl")
	usage := map[string]any{"input_tokens": 1, "output_tokens": 2}
	writeFile(t, p, claudeAssistantRow("msg_1", "claude-opus-5-5", "2026-11-10T10:00:00Z", usage)+"\n")
	if recs := readUsageFile(t, u, "claude", p); len(recs) != 1 {
		t.Fatalf("first = %+v", recs)
	}
	appendFile(t, p, claudeAssistantRow("msg_2", "claude-opus-5-5", "2026-11-10T10:01:00Z", usage)+"\n")
	recs := readUsageFile(t, u, "claude", p)
	if len(recs) != 2 || recs[1].key != "msg_2" {
		t.Fatalf("after an append = %+v", recs)
	}
	// The copy handed out is not changed by a later read.
	recs[0].input = 99
	if again := readUsageFile(t, u, "claude", p); again[0].input != 1 {
		t.Error("records were shared with a caller")
	}
}

func TestUsageTotals(t *testing.T) {
	at := time.Date(2026, 11, 10, 10, 14, 59, 0, time.FixedZone("x", 5*3600+1800))
	tot := newUsageTotals()
	tot.add("claude", false, usageRecord{at: at, model: "claude-opus-5-5", input: 1_000_000})
	tot.add("claude", false, usageRecord{at: at.Add(time.Second), model: "claude-opus-5-5", output: 1_000_000})
	tot.add("claude", true, usageRecord{at: at, model: "mystery", input: 7})
	if c := tot.main["claude-opus-5-5"]; c.input != 1_000_000 || c.output != 1_000_000 || c.cost != 24 {
		t.Errorf("main = %+v", c)
	}
	if c := tot.sub["mystery"]; c.input != 7 || c.cost != 0 {
		t.Errorf("sub = %+v", c)
	}
	// 10:14:59 at +05:30 is 04:44:59 UTC, in the 04:30 bucket; a second
	// later is the next one.
	first := usageBucketKey{time.Date(2026, 11, 10, 4, 30, 0, 0, time.UTC), "claude"}
	second := usageBucketKey{time.Date(2026, 11, 10, 4, 45, 0, 0, time.UTC), "claude"}
	if len(tot.buckets) != 2 || tot.buckets[first]["claude-opus-5-5"].input != 1_000_000 || tot.buckets[second]["claude-opus-5-5"].output != 1_000_000 {
		t.Errorf("buckets = %+v", tot.buckets)
	}
	var sum tokenCounts
	sum.plus(tot.main["claude-opus-5-5"])
	if sum.total() != 2_000_000 || sum.cost != 24 {
		t.Errorf("plus = %+v", sum)
	}
}
