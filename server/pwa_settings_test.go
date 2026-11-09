package main

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// The cases the PWA's settings registry runs too: a proposal is refused
// for exactly the keys listed in bad.
func TestSettingsProposalCases(t *testing.T) {
	data, err := os.ReadFile("testdata/pwa-settings-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name   string          `json:"name"`
			Values json.RawMessage `json:"values"`
			Bad    []string        `json:"bad"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	for _, c := range file.Cases {
		values, problems := validateSettingsProposal(c.Values)
		var bad []string
		for _, p := range problems {
			if p.Reason == "" {
				t.Errorf("%s: %s has no reason", c.Name, p.Key)
			}
			bad = append(bad, p.Key)
		}
		if !slices.Equal(bad, c.Bad) && !(len(bad) == 0 && len(c.Bad) == 0) {
			t.Errorf("%s: refused %v, want %v (%v)", c.Name, bad, c.Bad, problems)
		}
		if len(c.Bad) == 0 && len(values) == 0 {
			t.Errorf("%s: no values kept", c.Name)
		}
	}
}

func TestSettingsProposalWhole(t *testing.T) {
	for name, raw := range map[string]string{
		"not json":     `{`,
		"a list":       `[1]`,
		"null":         `null`,
		"empty":        `{}`,
		"two objects":  `{"editorVim":true} {"editorVim":false}`,
		"a string":     `"x"`,
		"too large":    `{"terminalFont":"` + strings.Repeat("a", maxSettingsProposal) + `"}`,
		"empty string": ``,
	} {
		values, problems := validateSettingsProposal([]byte(raw))
		if values != nil || len(problems) != 1 || problems[0].Key != "" || problems[0].Reason == "" {
			t.Errorf("%s: %v %v", name, values, problems)
		}
	}
}

// Kept values are compact JSON, as sent on to the PWA.
func TestSettingsProposalCompacts(t *testing.T) {
	values, problems := validateSettingsProposal([]byte(`{ "findExcludes" : [ "a" , "b" ], "theme": "dark" }`))
	if problems != nil || string(values["findExcludes"]) != `["a","b"]` || string(values["theme"]) != `"dark"` {
		t.Fatalf("%q %v", values, problems)
	}
}

// Every reason names what is wrong in words an agent can act on.
func TestSettingsProposalReasons(t *testing.T) {
	for raw, want := range map[string]string{
		`{"editorFontSize":99}`:                                     "must be one of 11, 12",
		`{"sidebarWidth":1}`:                                        "must be from 208 to 560",
		`{"sidebarWidth":1.5}`:                                      "whole number",
		`{"theme":"blue"}`:                                          `"light", "dark", "system"`,
		`{"nope":true}`:                                             "termote settings schema",
		`{"notifyAgents":true}`:                                     "device only",
		`{"terminalFont":"‮"}`:                                      "hidden",
		`{"findExcludes":["x​"]}`:                                   "hidden",
		`{"shortcuts":{"tab.new":{"key":"Shift+Mod+K"}}}`:           `as "Mod+Shift+K"`,
		`{"shortcuts":{"tab.new":{"key":"Mod+W"}}}`:                 "browser",
		`{"shortcuts":{"tab.new":{"key":"K"}}}`:                     "not a chord",
		`{"shortcuts":{"zz":null}}`:                                 `"zz" is not a command`,
		`{"shortcuts":{"tab.new":{"key":true}}}`:                    "key must be",
		`{"shortcuts":{"tab.new":{"inTerminal":"yes"}}}`:            "inTerminal must",
		`{"shortcuts":{"tab.new":{"x":1}}}`:                         `unknown field "x"`,
		`{"shortcuts":{"tab.new":[]}}`:                              "object or null",
		`{"shortcuts":{"tab.new":{}}}`:                              "changes nothing",
		`{"shortcuts":{}}`:                                          "changes no shortcut",
		`{"shortcuts":5}`:                                           "object of commands",
		`{"findExcludes":[1]}`:                                      "list of folder names",
		`{"findExcludes":5}`:                                        "list of folder names",
		`{"findExcludes":["."]}`:                                    "not a folder name",
		`{"findExcludes":["a/b"]}`:                                  "a path",
		`{"findExcludes":["a?"]}`:                                   "a pattern",
		`{"findExcludes":[""]}`:                                     "empty name",
		`{"findExcludes":["a","a"]}`:                                "twice",
		`{"findExcludes":["` + strings.Repeat("x", 256) + `"]}`:     "longer than 255",
		`{"terminalFont":"` + strings.Repeat("x", 201) + `"}`:       "longer than 200",
		`{"terminalFont":" x"}`:                                     "space",
		`{"terminalFont":1}`:                                        "a string",
		`{"editorVim":1}`:                                           "true or false",
		`{"editorVim":null}`:                                        "null",
		`{"findExcludes":["` + strings.Repeat("a\",\"", 51) + `"]}`: "more than 50",
	} {
		_, problems := validateSettingsProposal([]byte(raw))
		if len(problems) != 1 || !strings.Contains(problems[0].Reason, want) {
			t.Errorf("%s: %v, want a reason with %q", raw, problems, want)
		}
	}
}

func TestNormalChord(t *testing.T) {
	for in, want := range map[string]string{
		"Mod+Shift+P":      "Mod+Shift+P",
		"Shift+Mod+P":      "Mod+Shift+P",
		"Alt+Ctrl+Enter":   "Ctrl+Alt+Enter",
		"F1":               "F1",
		"Shift+F12":        "Shift+F12",
		"Meta+1":           "Meta+1",
		"P":                "",
		"Alt+P":            "",
		"Mod+F13":          "",
		"Mod+Hyper+P":      "",
		"Mod+Mod+P":        "",
		"":                 "",
		"Mod+":             "",
		"Mod+ArrowLeft":    "Mod+ArrowLeft",
		"Mod+Shift+Escape": "Mod+Shift+Escape",
	} {
		if got := normalChord(in); got != want {
			t.Errorf("normalChord(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseSettingsSchema(t *testing.T) {
	if pwaSettings.V != 1 || len(pwaSettings.Keys) == 0 || len(pwaSettings.DeviceOnly) == 0 {
		t.Fatalf("embedded schema: %+v", pwaSettings)
	}
	for name, data := range map[string]string{
		"not json":       `{`,
		"empty key":      `{"keys":[{"key":"","type":"boolean"}]}`,
		"twice":          `{"keys":[{"key":"a","type":"boolean"},{"key":"a","type":"boolean"}]}`,
		"unknown type":   `{"keys":[{"key":"a","type":"float"}]}`,
		"enum no values": `{"keys":[{"key":"a","type":"enum"}]}`,
		"integer no max": `{"keys":[{"key":"a","type":"integer","min":1}]}`,
		"string no max":  `{"keys":[{"key":"a","type":"string"}]}`,
		"names no max":   `{"keys":[{"key":"a","type":"names","maxBytes":1}]}`,
		"no commands":    `{"keys":[{"key":"a","type":"shortcuts"}]}`,
	} {
		if _, err := parseSettingsSchema([]byte(data)); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
	defer func() {
		if recover() == nil {
			t.Error("a broken schema did not panic")
		}
	}()
	mustParseSettingsSchema([]byte(`{`))
}

// A device-only key is never in the schema too.
func TestSettingsSchemaDeviceOnlyApart(t *testing.T) {
	for _, k := range pwaSettings.DeviceOnly {
		if _, ok := pwaSettings.spec(k); ok {
			t.Errorf("%s is device-only and in the schema", k)
		}
	}
}
