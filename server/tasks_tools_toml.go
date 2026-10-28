package main

import (
	"context"
	"errors"
	"slices"

	"github.com/BurntSushi/toml"
)

const (
	// maxTaskTOML bounds a TOML file the Tasks view decodes: the decoder
	// costs far more than the bytes on some shapes (see tomlPrescan).
	maxTaskTOML = 256 << 10
	// maxTOMLDepth and maxTOMLSegments bound the nesting of arrays and
	// inline tables, and the dotted parts of a key or table header, the
	// decoder is handed; maxTOMLPath the parts of a key's whole path, through
	// every inline table and array it is in.
	maxTOMLDepth    = 32
	maxTOMLSegments = 16
	maxTOMLPath     = 32
	// tomlDecodeSlots TOML files are decoded at once, server-wide.
	tomlDecodeSlots = 2
)

var (
	errTOMLHostile = errors.New("toml nesting or dotted key too deep")
	errTOMLBusy    = errors.New("no toml decode slot")

	// tomlSlots holds a slot per TOML decode running.
	tomlSlots = make(chan struct{}, tomlDecodeSlots)
)

// tomlPrescan refuses a TOML text whose arrays or inline tables nest deeper
// than maxTOMLDepth, with a run of more than maxTOMLSegments dotted parts, or
// a key path longer than maxTOMLPath parts (a dotted key in an inline table in
// another, each short), outside strings and comments, before the decoder sees
// it: the decoder's cost grows with the square of the path (a 40 KB dotted key
// takes gigabytes). A dot in a value (a float, a time) counts too: no valid
// value has many.
func tomlPrescan(b []byte) error {
	// dots counts the dots of the key being read; key is the parts of the
	// key whose value is being read, after its '='.
	dots, key := 0, 0
	// levels holds the parts each open array or inline table adds to the
	// path (the key that opened it, else one); path is their sum.
	var levels []int
	path := 0
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch c {
		case '#':
			for i < len(b) && b[i] != '\n' {
				i++
			}
			dots = 0
		case '"', '\'':
			i = tomlSkipString(b, i)
		case '.':
			if dots++; dots >= maxTOMLSegments || path+dots+1 > maxTOMLPath {
				return errTOMLHostile
			}
		case '[', '{':
			n := max(key, 1)
			levels = append(levels, n)
			path += n
			if len(levels) > maxTOMLDepth || path > maxTOMLPath {
				return errTOMLHostile
			}
			dots, key = 0, 0
		case ']', '}':
			if n := len(levels); n > 0 {
				path -= levels[n-1]
				levels = levels[:n-1]
			}
			dots, key = 0, 0
		case '=':
			dots, key = 0, dots+1
		case '\n', ',':
			dots, key = 0, 0
		}
	}
	return nil
}

// tomlSkipString returns the index of the last byte of the string opening
// at b[i] (one quote, or three for a multi-line string), or len(b) when it
// never closes: the decoder then refuses the file.
func tomlSkipString(b []byte, i int) int {
	q := b[i]
	if i+2 < len(b) && b[i+1] == q && b[i+2] == q {
		for j := i + 3; j+2 < len(b); j++ {
			if q == '"' && b[j] == '\\' {
				j++
				continue
			}
			if b[j] == q && b[j+1] == q && b[j+2] == q {
				// A multi-line string may end in up to two more quotes.
				for j+3 < len(b) && b[j+3] == q {
					j++
				}
				return j + 2
			}
		}
		return len(b)
	}
	for j := i + 1; j < len(b); j++ {
		switch {
		case q == '"' && b[j] == '\\':
			j++
		case b[j] == q:
			return j
		case b[j] == '\n':
			return j
		}
	}
	return len(b)
}

// decodeTaskTOML decodes b into v, a struct naming only the tables the
// Tasks view reads, after tomlPrescan, under a slot of tomlSlots: waits for
// one until ctx ends (errTOMLBusy).
func decodeTaskTOML(ctx context.Context, b []byte, v any) (toml.MetaData, error) {
	if err := tomlPrescan(b); err != nil {
		return toml.MetaData{}, err
	}
	select {
	case tomlSlots <- struct{}{}:
		defer func() { <-tomlSlots }()
	case <-ctx.Done():
		return toml.MetaData{}, errTOMLBusy
	}
	return toml.Decode(string(b), v)
}

// tomlKeysUnder lists the keys right under the table at prefix in the
// file's order (a map decoded loses it), each once. A key only defined by a
// longer one (a.b = 1 defines a) is named by that one.
func tomlKeysUnder(md toml.MetaData, prefix ...string) []string {
	var out []string
	seen := map[string]bool{}
	for _, k := range md.Keys() {
		if len(k) > len(prefix) && slices.Equal(k[:len(prefix)], prefix) && !seen[k[len(prefix)]] {
			seen[k[len(prefix)]] = true
			out = append(out, k[len(prefix)])
		}
	}
	return out
}

// pyprojectDoc is what pyproject.toml holds for PDM, Hatch and Poe.
type pyprojectDoc struct {
	Tool struct {
		PDM struct {
			Scripts map[string]any `toml:"scripts"`
		} `toml:"pdm"`
		Hatch hatchDoc `toml:"hatch"`
		Poe   struct {
			Tasks map[string]any `toml:"tasks"`
		} `toml:"poe"`
	} `toml:"tool"`
}

// hatchDoc is hatch.toml, or pyproject's [tool.hatch]: the scripts of each
// environment.
type hatchDoc struct {
	Envs map[string]struct {
		Scripts map[string]any `toml:"scripts"`
	} `toml:"envs"`
}

// cargoDoc is what Cargo.toml says about binaries.
type cargoDoc struct {
	Bin []map[string]any `toml:"bin"`
}

// cargoConfigDoc is the [alias] table of .cargo/config(.toml).
type cargoConfigDoc struct {
	Alias map[string]any `toml:"alias"`
}
