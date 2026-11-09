package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// The PWA settings an agent may propose (termote settings propose) and the
// PWA's Export/Import carries: one list, read here and by the PWA's tests
// (pwa/src/utils/settings-registry.test.ts), which check it against the
// PWA's defaults and resolvers. Both run testdata/pwa-settings-cases.json.
//
//go:embed pwa_settings_schema.json
var pwaSettingsSchemaJSON []byte

// maxSettingsProposal bounds a proposal's JSON: room for 50 excluded
// folder names of 255 bytes and every shortcut.
const maxSettingsProposal = 32 << 10

type pwaSettingSpec struct {
	Key         string   `json:"key"`
	Store       string   `json:"store"`
	Type        string   `json:"type"`
	Values      []any    `json:"values,omitempty"`
	Min         *int     `json:"min,omitempty"`
	Max         *int     `json:"max,omitempty"`
	MaxItems    int      `json:"maxItems,omitempty"`
	MaxBytes    int      `json:"maxBytes,omitempty"`
	Commands    []string `json:"commands,omitempty"`
	Default     any      `json:"default"`
	Description string   `json:"description"`
}

type pwaSettingsSchema struct {
	V int `json:"v"`
	// DeviceOnly are PWA settings never proposed nor imported: turning
	// notifications or the badge on asks for a permission in a click.
	DeviceOnly []string         `json:"deviceOnly"`
	Keys       []pwaSettingSpec `json:"keys"`
}

// settingsProblem is why one key (empty: the whole proposal) is refused.
type settingsProblem struct {
	Key    string `json:"key"`
	Reason string `json:"reason"`
}

var pwaSettings = mustParseSettingsSchema(pwaSettingsSchemaJSON)

func mustParseSettingsSchema(data []byte) pwaSettingsSchema {
	s, err := parseSettingsSchema(data)
	if err != nil {
		panic(err)
	}
	return s
}

func parseSettingsSchema(data []byte) (pwaSettingsSchema, error) {
	var s pwaSettingsSchema
	if err := json.Unmarshal(data, &s); err != nil {
		return s, fmt.Errorf("pwa settings schema: %v", err)
	}
	seen := map[string]bool{}
	for _, k := range s.Keys {
		switch {
		case k.Key == "" || seen[k.Key]:
			return s, fmt.Errorf("pwa settings schema: key %q empty or twice", k.Key)
		case !slices.Contains([]string{"boolean", "enum", "integer", "string", "names", "shortcuts"}, k.Type):
			return s, fmt.Errorf("pwa settings schema: %s has type %q", k.Key, k.Type)
		case k.Type == "enum" && len(k.Values) == 0,
			k.Type == "integer" && (k.Min == nil || k.Max == nil),
			k.Type == "string" && k.MaxBytes == 0,
			k.Type == "names" && (k.MaxBytes == 0 || k.MaxItems == 0),
			k.Type == "shortcuts" && len(k.Commands) == 0:
			return s, fmt.Errorf("pwa settings schema: %s lacks what its type needs", k.Key)
		}
		seen[k.Key] = true
	}
	return s, nil
}

func (s pwaSettingsSchema) spec(key string) (pwaSettingSpec, bool) {
	for _, k := range s.Keys {
		if k.Key == key {
			return k, true
		}
	}
	return pwaSettingSpec{}, false
}

// validateSettingsProposal checks a proposal, a JSON object of setting
// values, against the schema. It returns the values as compact JSON when
// every key is valid, else every problem, sorted by key.
func validateSettingsProposal(raw []byte) (map[string]json.RawMessage, []settingsProblem) {
	whole := func(reason string) []settingsProblem { return []settingsProblem{{Reason: reason}} }
	if len(raw) > maxSettingsProposal {
		return nil, whole(fmt.Sprintf("the proposal is larger than %d KiB", maxSettingsProposal>>10))
	}
	var obj map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&obj); err != nil || obj == nil || dec.More() {
		return nil, whole("the proposal is not one JSON object")
	}
	if len(obj) == 0 {
		return nil, whole("the proposal changes nothing")
	}
	out := map[string]json.RawMessage{}
	var problems []settingsProblem
	for key, value := range obj {
		spec, ok := pwaSettings.spec(key)
		var reason string
		switch {
		case slices.Contains(pwaSettings.DeviceOnly, key):
			reason = "set on the device only, never proposed"
		case !ok:
			reason = "unknown setting (see: termote settings schema)"
		default:
			reason = checkSettingValue(spec, value)
		}
		if reason != "" {
			problems = append(problems, settingsProblem{key, reason})
			continue
		}
		var b bytes.Buffer
		json.Compact(&b, value)
		out[key] = b.Bytes()
	}
	if len(problems) > 0 {
		sort.Slice(problems, func(i, j int) bool { return problems[i].Key < problems[j].Key })
		return nil, problems
	}
	return out, nil
}

// checkSettingValue is why value cannot be spec's, or "".
func checkSettingValue(spec pwaSettingSpec, value json.RawMessage) string {
	if isJSONNull(value) {
		return "must not be null"
	}
	switch spec.Type {
	case "boolean":
		var b bool
		if json.Unmarshal(value, &b) != nil {
			return "must be true or false"
		}
	case "enum":
		var v any
		json.Unmarshal(value, &v)
		if !slices.ContainsFunc(spec.Values, func(a any) bool { return a == v }) {
			return "must be one of " + formatValues(spec.Values)
		}
	case "integer":
		var f float64
		if json.Unmarshal(value, &f) != nil || f != math.Trunc(f) {
			return "must be a whole number"
		}
		if f < float64(*spec.Min) || f > float64(*spec.Max) {
			return fmt.Sprintf("must be from %d to %d", *spec.Min, *spec.Max)
		}
	case "string":
		var s string
		if json.Unmarshal(value, &s) != nil {
			return "must be a string"
		}
		return checkSettingString(s, spec.MaxBytes)
	case "names":
		return checkFindExcludes(value, spec)
	case "shortcuts":
		return checkShortcuts(value, spec.Commands)
	}
	return ""
}

func formatValues(values []any) string {
	parts := make([]string, len(values))
	for i, v := range values {
		b, _ := json.Marshal(v)
		parts[i] = string(b)
	}
	return strings.Join(parts, ", ")
}

// unsafeText reports control characters and characters that show nothing,
// as prompt templates refuse them: a value read in the PWA's before/after
// table must hide nothing.
func unsafeText(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || hiddenRune(r) })
}

func checkSettingString(s string, maxBytes int) string {
	// JSON decoding left s valid UTF-8.
	switch {
	case len(s) > maxBytes:
		return fmt.Sprintf("is longer than %d bytes", maxBytes)
	case strings.TrimSpace(s) != s:
		return "starts or ends with a space"
	case unsafeText(s):
		return "contains control or hidden characters"
	}
	return ""
}

// checkFindExcludes holds the PWA's findExcludeProblem rules: each one
// directory name, never a path or a pattern, each once.
func checkFindExcludes(value json.RawMessage, spec pwaSettingSpec) string {
	var names []any
	if json.Unmarshal(value, &names) != nil {
		return "must be a list of folder names"
	}
	if len(names) > spec.MaxItems {
		return fmt.Sprintf("holds more than %d names", spec.MaxItems)
	}
	seen := map[string]bool{}
	for _, v := range names {
		name, ok := v.(string)
		switch {
		case !ok:
			return "must be a list of folder names"
		case name == "":
			return "holds an empty name"
		case name == "." || name == ".." || strings.Contains(name, "\x00"):
			return fmt.Sprintf("%q is not a folder name", name)
		case strings.ContainsAny(name, `/\`):
			return fmt.Sprintf("%q is a path, not one folder name", name)
		case strings.ContainsAny(name, "*?["):
			return fmt.Sprintf("%q is a pattern, not one folder name", name)
		case len(name) > spec.MaxBytes:
			return fmt.Sprintf("a name is longer than %d bytes", spec.MaxBytes)
		case unsafeText(name):
			return fmt.Sprintf("%q contains control or hidden characters", name)
		case seen[name]:
			return fmt.Sprintf("%q is listed twice", name)
		}
		seen[name] = true
	}
	return ""
}

// The chord grammar of the PWA's parseChord (pwa/src/utils/shortcuts.ts).
var (
	chordModifiers = []string{"Mod", "Ctrl", "Meta", "Alt", "Shift"}
	chordNamedKeys = []string{"Comma", "Period", "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight",
		"Backslash", "Minus", "Equal", "Backquote", "Enter", "Space", "Tab", "Backspace", "Delete", "Insert",
		"Escape", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"}
	chordFunctionKey = regexp.MustCompile(`^F([1-9]|1[0-2])$`)
	chordCharKey     = regexp.MustCompile(`^[A-Z0-9]$`)
	// Chords the PWA refuses on every platform: the browser keeps them, or
	// the editor or text editing uses them (isRefusedChord). The rest of
	// its refusals depend on the device, which shows them as skipped.
	chordRefused = []string{"Mod+W", "Mod+T", "Mod+N", "Mod+Q", "Mod+Shift+T", "Mod+Shift+N", "Mod+Shift+W",
		"Mod+S", "Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z"}
)

// normalChord is the PWA's parseChord: the chord in its normal form, or ""
// when the text is not one a shortcut can have.
func normalChord(chord string) string {
	tokens := strings.Split(chord, "+")
	key := tokens[len(tokens)-1]
	if !chordCharKey.MatchString(key) && !chordFunctionKey.MatchString(key) && !slices.Contains(chordNamedKeys, key) {
		return ""
	}
	mods := map[string]bool{}
	for _, t := range tokens[:len(tokens)-1] {
		if !slices.Contains(chordModifiers, t) || mods[t] {
			return ""
		}
		mods[t] = true
	}
	if !mods["Mod"] && !mods["Ctrl"] && !mods["Meta"] && !chordFunctionKey.MatchString(key) {
		return ""
	}
	var parts []string
	for _, m := range chordModifiers {
		if mods[m] {
			parts = append(parts, m)
		}
	}
	return strings.Join(append(parts, key), "+")
}

// checkShortcuts checks {command: {key, inTerminal} | null}.
func checkShortcuts(value json.RawMessage, commands []string) string {
	var entries map[string]json.RawMessage
	if json.Unmarshal(value, &entries) != nil || entries == nil {
		return "must be an object of commands"
	}
	if len(entries) == 0 {
		return "changes no shortcut"
	}
	ids := make([]string, 0, len(entries))
	for id := range entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if !slices.Contains(commands, id) {
			return fmt.Sprintf("%q is not a command (see: termote settings schema)", id)
		}
		if reason := checkShortcut(entries[id]); reason != "" {
			return id + ": " + reason
		}
	}
	return ""
}

func checkShortcut(raw json.RawMessage) string {
	if isJSONNull(raw) {
		return ""
	}
	var entry map[string]json.RawMessage
	if json.Unmarshal(raw, &entry) != nil || entry == nil {
		return "must be an object or null"
	}
	if len(entry) == 0 {
		return "changes nothing"
	}
	for field, v := range entry {
		switch field {
		case "key":
			if isJSONNull(v) {
				continue
			}
			var chord string
			if json.Unmarshal(v, &chord) != nil {
				return "key must be a chord or null"
			}
			switch n := normalChord(chord); {
			case n == "":
				return fmt.Sprintf("%q is not a chord a shortcut can have", chord)
			case n != chord:
				return fmt.Sprintf("write %q as %q", chord, n)
			case slices.Contains(chordRefused, n):
				return fmt.Sprintf("%q is kept by the browser or used for text", n)
			}
		case "inTerminal":
			var b bool
			if json.Unmarshal(v, &b) != nil {
				return "inTerminal must be true or false"
			}
		default:
			return fmt.Sprintf("unknown field %q", field)
		}
	}
	return ""
}
