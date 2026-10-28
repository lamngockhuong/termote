package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestTOMLPrescan(t *testing.T) {
	deep := strings.Repeat("[", maxTOMLDepth+1)
	dotted := "a" + strings.Repeat(".a", maxTOMLSegments) + " = 1"
	for _, tc := range []struct {
		text string
		ok   bool
	}{
		{"[tool.pdm.scripts]\ntest = \"pytest\"\n", true},
		{"a" + strings.Repeat(".a", maxTOMLSegments-1) + " = 1", true},
		{dotted, false},
		{"[" + strings.TrimSuffix(dotted, " = 1") + "]", false},
		{"x = " + strings.Repeat("[", maxTOMLDepth) + strings.Repeat("]", maxTOMLDepth), true},
		{"x = " + deep, false},
		{"x = " + strings.Repeat("{a=", maxTOMLDepth+1), false},
		// Short dotted keys in nested inline tables: the whole path counts.
		{"x = {" + strings.Repeat("a.", 14) + "a = {" + strings.Repeat("b.", 14) + "b = 1}}", true},
		{"x = {" + strings.Repeat("a.", 15) + "a = {" + strings.Repeat("b.", 15) + "b = 1}}", false},
		{"x = [{" + strings.Repeat("a.", 15) + "a = [{" + strings.Repeat("b.", 15) + "b = 1}]}]", false},
		{"[" + strings.Repeat("a.", 14) + "a]\nx = {" + strings.Repeat("b.", 14) + "b = 1}", true},
		{"x = ]]" + strings.Repeat("a.", 10) + "a", true},
		// Dots and brackets in strings and comments are no structure.
		{`x = "` + strings.Repeat(".[", 100) + `"`, true},
		{"x = '" + strings.Repeat(".[", 100) + "'", true},
		{`x = """` + strings.Repeat(".[\n", 100) + `"""`, true},
		{"x = '''" + strings.Repeat(".[\n", 100) + "''''", true},
		{"# " + strings.Repeat(".[", 100) + "\nx = 1", true},
		{`x = "a\".` + strings.Repeat(".", 20) + `"`, true},
		{`x = """a\"""` + strings.Repeat(".", 20) + `"""`, true},
		// Separators end a run of dots: values and keys each count alone.
		{strings.Repeat("a.a.a.a.a.a.a.a = 1.5\n", 50), true},
		{"x = [" + strings.Repeat("1.5, ", 50) + "]", true},
		// An unclosed string: the decoder refuses the file later.
		{`x = "` + strings.Repeat(".", 20), true},
		{`x = """` + strings.Repeat(".", 20), true},
		{"x = \"a\n" + strings.Repeat(".", 20), false},
	} {
		if err := tomlPrescan([]byte(tc.text)); (err == nil) != tc.ok {
			t.Errorf("%.60q = %v, want ok %v", tc.text, err, tc.ok)
		}
	}
}

// The shapes that cost the decoder gigabytes are refused at once, the
// largest file allowed.
func TestTOMLHostileBounded(t *testing.T) {
	dotted := "a" + strings.Repeat(".a", maxTaskTOML/2-2) + " = 1"
	nested := "x = " + strings.Repeat("{a=", maxTaskTOML/3-2)
	arrays := "x = " + strings.Repeat("[", maxTaskTOML-8)
	// Each key short, the paths long: inline tables of dotted keys, in
	// arrays or not, one per line until the file is full.
	seg := "a" + strings.Repeat(".a", maxTOMLSegments-1)
	fill := func(open, close string) string {
		line := strings.Repeat(open+seg+" = ", maxTOMLDepth-1) + "1" + strings.Repeat(close, maxTOMLDepth-1)
		var sb strings.Builder
		for i := 0; sb.Len() < maxTaskTOML-len(line)-20; i++ {
			fmt.Fprintf(&sb, "k%d = %s\n", i, line)
		}
		return sb.String()
	}
	for name, text := range map[string]string{"dotted": dotted, "nested": nested, "arrays": arrays,
		"tables": fill("{", "}"), "arrays of tables": fill("[{", "}]")} {
		var doc pyprojectDoc
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		start := time.Now()
		_, err := decodeTaskTOML(context.Background(), []byte(text), &doc)
		took := time.Since(start)
		runtime.ReadMemStats(&after)
		if !errors.Is(err, errTOMLHostile) || took > 100*time.Millisecond || after.TotalAlloc-before.TotalAlloc > 32<<20 {
			t.Errorf("%s: %v in %v, %d bytes", name, err, took, after.TotalAlloc-before.TotalAlloc)
		}
	}
}

// A decode waits for a slot until its context ends.
func TestDecodeTaskTOMLBusy(t *testing.T) {
	for range tomlDecodeSlots {
		tomlSlots <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	var doc pyprojectDoc
	_, err := decodeTaskTOML(ctx, []byte("a = 1"), &doc)
	for range tomlDecodeSlots {
		<-tomlSlots
	}
	if !errors.Is(err, errTOMLBusy) {
		t.Fatalf("busy = %v", err)
	}
	if _, err := decodeTaskTOML(context.Background(), []byte("a = 1"), &doc); err != nil || len(tomlSlots) != 0 {
		t.Fatalf("after = %v, %d slots held", err, len(tomlSlots))
	}
}

func TestTOMLKeysUnder(t *testing.T) {
	var doc pyprojectDoc
	md, err := decodeTaskTOML(context.Background(), []byte(`
[tool.pdm.scripts]
zeta = "z"
alpha = {cmd = "a"}
[tool.pdm.scripts.mid]
shell = "m"
[tool.other]
x = 1
`), &doc)
	if err != nil {
		t.Fatal(err)
	}
	if got := tomlKeysUnder(md, "tool", "pdm", "scripts"); !slices.Equal(got, []string{"zeta", "alpha", "mid"}) {
		t.Errorf("keys = %v", got)
	}
}
