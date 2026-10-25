package main

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

// codexSkillRulesMax caps the [[skills.config]] entries read; with more,
// none is applied.
const codexSkillRulesMax = 1000

// codexConfig is CODEX_HOME/config.toml decoded into plain values. Keys are
// matched exactly, as serde does: decoding into a Go struct would match
// "Enabled" to an enabled field.
type codexConfig map[string]any

// readCodexConfig decodes codexHome/config.toml. It may be a symlink
// (dotfile managers link it); it must be a regular file of at most
// pluginJSONMax, opened without blocking. A file that does not decode reads
// as missing: no plugin and no skill rule.
func readCodexConfig(codexHome string) codexConfig {
	if codexHome == "" {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(codexHome, "config.toml"), os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > pluginJSONMax {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(f, pluginJSONMax))
	if err != nil {
		return nil
	}
	var cfg codexConfig
	if _, err := toml.Decode(string(b), &cfg); err != nil {
		return nil
	}
	return cfg
}

// tomlTable returns v as a table, or false.
func tomlTable(v any) (map[string]any, bool) {
	t, ok := v.(map[string]any)
	return t, ok
}

// tomlTables returns v as an array of tables, or false (an array of tables
// decodes as []map[string]any, an inline array as []any).
func tomlTables(v any) ([]map[string]any, bool) {
	switch a := v.(type) {
	case []map[string]any:
		return a, true
	case []any:
		out := make([]map[string]any, 0, len(a))
		for _, e := range a {
			t, ok := tomlTable(e)
			if !ok {
				return nil, false
			}
			out = append(out, t)
		}
		return out, true
	}
	return nil, false
}

// tomlOpt reports whether key is absent from t or holds a T, and its value.
func tomlOpt[T any](t map[string]any, key string) (T, bool, bool) {
	var zero T
	v, ok := t[key]
	if !ok {
		return zero, false, true
	}
	x, isT := v.(T)
	return x, true, isT
}

// tomlOptOK reports whether each key is absent from t or holds a T.
func tomlOptOK[T any](t map[string]any, keys ...string) bool {
	for _, k := range keys {
		if _, _, ok := tomlOpt[T](t, k); !ok {
			return false
		}
	}
	return true
}

// tomlStrings reports whether key is absent from t or a list of strings.
func tomlStrings(t map[string]any, key string) bool {
	v, ok := t[key]
	if !ok {
		return true
	}
	a, ok := v.([]any)
	if !ok {
		return false
	}
	for _, e := range a {
		if _, ok := e.(string); !ok {
			return false
		}
	}
	return true
}

// validApprovalMode reports whether the approval mode at key, if any, names
// an AppToolApproval.
func validApprovalMode(t map[string]any, key string) bool {
	m, set, ok := tomlOpt[string](t, key)
	return ok && (!set || m == "auto" || m == "prompt" || m == "writes" || m == "approve")
}

// validCodexPluginEntry reports whether Codex decodes the plugin entry v as a
// PluginConfig (enabled, remote_plugin_id, release_id, auto_provision,
// mcp_servers), with the enum values and the positive output_token_limit (a
// NonZeroUsize) of its MCP servers' tools. Keys Codex does not know are
// ignored, by Codex too.
func validCodexPluginEntry(v any) bool {
	e, ok := tomlTable(v)
	if !ok || !tomlOptOK[bool](e, "enabled", "auto_provision") || !tomlOptOK[string](e, "remote_plugin_id", "release_id") {
		return false
	}
	servers, set, ok := tomlOpt[map[string]any](e, "mcp_servers")
	if !ok {
		return false
	}
	if !set {
		return true
	}
	for _, sv := range servers {
		// PluginMcpServerConfig; ema_auth takes any value.
		s, ok := tomlTable(sv)
		if !ok || !tomlOptOK[bool](s, "enabled") || !validApprovalMode(s, "default_tools_approval_mode") ||
			!tomlStrings(s, "enabled_tools") || !tomlStrings(s, "disabled_tools") {
			return false
		}
		tools, set, ok := tomlOpt[map[string]any](s, "tools")
		if !ok {
			return false
		}
		if !set {
			continue
		}
		for _, tv := range tools {
			// McpServerToolConfig.
			tool, ok := tomlTable(tv)
			if !ok || !validApprovalMode(tool, "approval_mode") {
				return false
			}
			if n, set, ok := tomlOpt[int64](tool, "output_token_limit"); !ok || set && n <= 0 {
				return false
			}
		}
	}
	return true
}

// codexPluginID is a parsed "<name>@<marketplace>" key.
type codexPluginID struct{ name, marketplace string }

// codexEnabledPlugins returns, in key order, the plugins cfg turns on: an
// entry's enabled, else [plugins._default] enabled, else on. [features]
// plugins = false, or an entry Codex would refuse, turns every plugin off: it
// decodes the plugins table as a whole. Keys that are not a valid plugin id
// and the openai-* marketplaces (curated, bundled and remote ones, loaded by
// Codex only for some sign-ins) are left out.
func codexEnabledPlugins(cfg codexConfig) []codexPluginID {
	if f, set := cfg["features"]; set {
		features, ok := tomlTable(f)
		if !ok {
			return nil
		}
		if on, set, ok := tomlOpt[bool](features, "plugins"); !ok || set && !on {
			return nil
		}
	}
	plugins, set, ok := tomlOpt[map[string]any](cfg, "plugins")
	if !ok || !set {
		return nil
	}
	defaultOn := true
	if dv, ok := plugins["_default"]; ok {
		// PluginsDefaultConfig.
		d, ok := tomlTable(dv)
		if !ok {
			return nil
		}
		on, set, ok := tomlOpt[bool](d, "enabled")
		if !ok {
			return nil
		}
		if set {
			defaultOn = on
		}
	}
	var out []codexPluginID
	for key, v := range plugins {
		if key == "_default" {
			continue
		}
		if !validCodexPluginEntry(v) {
			return nil
		}
		on := defaultOn
		if en, set, _ := tomlOpt[bool](v.(map[string]any), "enabled"); set {
			on = en
		}
		id, ok := parseCodexPluginID(key)
		if on && ok && !strings.HasPrefix(id.marketplace, "openai-") {
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].name+"@"+out[i].marketplace < out[j].name+"@"+out[j].marketplace
	})
	return out
}

// codexSkillsConfig is what the [skills] table of cfg says, as Codex reads
// it from the user layer (skill_config_rules_from_stack,
// bundled_skills_enabled_from_stack): the [[skills.config]] rules, and
// whether the skills bundled with Codex (CODEX_HOME/skills/.system) load. A
// table Codex would not decode as a SkillsConfig (a value of the wrong type,
// an entry without enabled) has no rules, and bundled skills stay on.
func codexSkillsConfig(cfg codexConfig, codexHome, home string, bases []string) (codexSkillRules, bool) {
	sv, set := cfg["skills"]
	if !set {
		return nil, true
	}
	skills, ok := tomlTable(sv)
	if !ok || !tomlOptOK[bool](skills, "include_instructions") {
		return nil, true
	}
	if n, set, ok := tomlOpt[int64](skills, "max_context_tokens"); !ok || set && n <= 0 {
		return nil, true
	}
	bundled := true
	if bv, set := skills["bundled"]; set {
		// BundledSkillsConfig; enabled defaults to true.
		b, ok := tomlTable(bv)
		if !ok {
			return nil, true
		}
		on, set, ok := tomlOpt[bool](b, "enabled")
		if !ok {
			return nil, true
		}
		if set {
			bundled = on
		}
	}
	cv, set := skills["config"]
	if !set {
		return nil, bundled
	}
	entries, ok := tomlTables(cv)
	if !ok {
		return nil, true
	}
	for _, e := range entries {
		if _, set, ok := tomlOpt[bool](e, "enabled"); !set || !ok || !tomlOptOK[string](e, "path", "name") {
			return nil, true
		}
	}
	if len(entries) > codexSkillRulesMax {
		return nil, bundled
	}
	return newCodexSkillRules(entries, codexHome, home, bases), bundled
}

// codexSkillRule is one [[skills.config]] entry: a SKILL.md path (clean,
// absolute, resolved when it could be) or a skill name, turned on or off.
type codexSkillRule struct {
	path, name string
	enabled    bool
}

// codexSkillRules are the entries in the order Codex applies them.
type codexSkillRules []codexSkillRule

// newCodexSkillRules builds the rules of entries (checked) as
// skill_config_rules_from_stack does: an entry with a path or a name (not
// both, not blank) is a rule, and one whose selector an earlier rule has
// replaces that rule.
func newCodexSkillRules(entries []map[string]any, codexHome, home string, bases []string) codexSkillRules {
	var rules codexSkillRules
	at := map[codexSkillRule]int{} // selector → index in rules
	for _, e := range entries {
		p, hasPath, _ := tomlOpt[string](e, "path")
		name, hasName, _ := tomlOpt[string](e, "name")
		enabled, _, _ := tomlOpt[bool](e, "enabled")
		var sel codexSkillRule
		switch {
		case hasPath && !hasName:
			sel.path = codexRulePath(p, codexHome, home, bases)
		case hasName && !hasPath && strings.TrimSpace(name) != "":
			sel.name = strings.TrimSpace(name)
		default:
			continue
		}
		if i, ok := at[sel]; ok {
			rules[i].path, rules[i].name = "", "" // replaced: dropped below
		}
		at[sel] = len(rules)
		rules = append(rules, codexSkillRule{path: sel.path, name: sel.name, enabled: enabled})
	}
	out := rules[:0]
	for _, r := range rules {
		if r.path != "" || r.name != "" {
			out = append(out, r)
		}
	}
	return out
}

// codexRulePath turns the path of a rule into the form skill paths are
// compared in, as Codex reads an AbsolutePathBuf: "~" for home, relative to
// config.toml's dir, cleaned. Its links are resolved (canonicalize) only when
// it lies in one of bases, the dirs skills are listed from: a SKILL.md
// anywhere else is never listed, and resolving a path on a stalled mount
// could hang the listing. The path itself is never opened.
func codexRulePath(p, codexHome, home string, bases []string) string {
	sep := "/"
	if runtime.GOOS == "windows" {
		sep = `/\`
	}
	if rest, ok := strings.CutPrefix(p, "~"); ok && home != "" && (rest == "" || strings.ContainsAny(rest[:1], sep)) {
		p = filepath.Join(home, strings.TrimLeft(rest, sep))
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(codexHome, p)
	}
	p = filepath.Clean(p)
	for _, b := range bases {
		if b != "" && pathWithin(b, p) {
			if real, err := filepath.EvalSymlinks(p); err == nil {
				return real
			}
			break
		}
	}
	return p
}

// samePath compares two clean absolute paths, ignoring case on Windows.
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// disabled returns, for each skill, whether the rules turn it off, as
// resolve_disabled_paths does: in order, a path rule turns its SKILL.md on or
// off, and a name rule every skill of that name.
func (rules codexSkillRules) disabled(skills []codexSkill) []bool {
	off := make([]bool, len(skills))
	for _, r := range rules {
		for i, s := range skills {
			if r.path != "" && samePath(r.path, s.path) || r.name != "" && r.name == s.cmd.Name {
				off[i] = !r.enabled
			}
		}
	}
	return off
}
