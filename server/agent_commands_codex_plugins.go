package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

// codexPluginMaxSkillRoots caps the skill dirs one plugin's manifest may name.
const codexPluginMaxSkillRoots = 8

// Codex plugins are listed as Codex 0.164.0 loads them (codex-rs/core-plugins,
// core-plugin-common, utils/plugins, config/src/types.rs), from the
// config.toml of CODEX_HOME only: a project's .codex/config.toml, -c overrides
// and the requirements an admin sets are not read. When Termote cannot tell
// whether Codex would load a plugin, its skills are left out.

// codexConfigFile is the part of config.toml read here. Codex decodes the
// plugins table as a whole: one entry of the wrong type and no plugin loads.
type codexConfigFile struct {
	Features map[string]any            `toml:"features"`
	Plugins  map[string]toml.Primitive `toml:"plugins"`
}

// codexPluginsDefault is [plugins._default] (PluginsDefaultConfig).
type codexPluginsDefault struct {
	Enabled *bool `toml:"enabled"`
}

// codexPluginConfig is one [plugins."<name>@<marketplace>"] entry
// (PluginConfig). Only enabled is used; the others are decoded for their
// types. Keys Codex does not know are ignored, by Codex too.
type codexPluginConfig struct {
	Enabled        *bool                           `toml:"enabled"`
	RemotePluginID *string                         `toml:"remote_plugin_id"`
	ReleaseID      *string                         `toml:"release_id"`
	AutoProvision  *bool                           `toml:"auto_provision"`
	MCPServers     map[string]codexPluginMCPServer `toml:"mcp_servers"`
}

// codexPluginMCPServer is PluginMcpServerConfig; ema_auth takes any value.
type codexPluginMCPServer struct {
	Enabled                  *bool                         `toml:"enabled"`
	EMAAuth                  any                           `toml:"ema_auth"`
	DefaultToolsApprovalMode *string                       `toml:"default_tools_approval_mode"`
	EnabledTools             []string                      `toml:"enabled_tools"`
	DisabledTools            []string                      `toml:"disabled_tools"`
	Tools                    map[string]codexPluginMCPTool `toml:"tools"`
}

// codexPluginMCPTool is McpServerToolConfig.
type codexPluginMCPTool struct {
	ApprovalMode     *string `toml:"approval_mode"`
	OutputTokenLimit *int64  `toml:"output_token_limit"`
}

// validApprovalMode reports whether m names an AppToolApproval.
func validApprovalMode(m *string) bool {
	return m == nil || *m == "auto" || *m == "prompt" || *m == "writes" || *m == "approve"
}

// valid reports whether Codex would decode the entry: the enum values and
// the positive output_token_limit (a NonZeroUsize) are not checked by the
// TOML decoder.
func (c codexPluginConfig) valid() bool {
	for _, s := range c.MCPServers {
		if !validApprovalMode(s.DefaultToolsApprovalMode) {
			return false
		}
		for _, tool := range s.Tools {
			if !validApprovalMode(tool.ApprovalMode) || (tool.OutputTokenLimit != nil && *tool.OutputTokenLimit <= 0) {
				return false
			}
		}
	}
	return true
}

// codexPluginID is a parsed "<name>@<marketplace>" key.
type codexPluginID struct{ name, marketplace string }

// codexEnabledPlugins returns, in key order, the plugins config.toml turns
// on: an entry's enabled, else [plugins._default] enabled, else on. config.toml
// may be a symlink (dotfile managers link it); it must be a regular file of
// at most pluginJSONMax, opened without blocking. A file that does not
// decode, [features] plugins = false, or an entry Codex would refuse turns
// every plugin off. Keys that are not a valid plugin id and the openai-*
// marketplaces (curated, bundled and remote ones, loaded by Codex only for
// some sign-ins) are left out.
func codexEnabledPlugins(codexHome string) []codexPluginID {
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
	var cfg codexConfigFile
	md, err := toml.Decode(string(b), &cfg)
	if err != nil {
		return nil
	}
	if v, ok := cfg.Features["plugins"]; ok {
		if on, isBool := v.(bool); !isBool || !on {
			return nil
		}
	}
	defaultOn := true
	if p, ok := cfg.Plugins["_default"]; ok {
		var d codexPluginsDefault
		if md.PrimitiveDecode(p, &d) != nil {
			return nil
		}
		if d.Enabled != nil {
			defaultOn = *d.Enabled
		}
	}
	var out []codexPluginID
	for key, p := range cfg.Plugins {
		if key == "_default" {
			continue
		}
		var c codexPluginConfig
		if md.PrimitiveDecode(p, &c) != nil || !c.valid() {
			return nil
		}
		on := defaultOn
		if c.Enabled != nil {
			on = *c.Enabled
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

// parseCodexPluginID splits key at its last "@" (PluginId::parse).
func parseCodexPluginID(key string) (codexPluginID, bool) {
	i := strings.LastIndexByte(key, '@')
	if i < 0 {
		return codexPluginID{}, false
	}
	id := codexPluginID{name: key[:i], marketplace: key[i+1:]}
	return id, validCodexPluginSegment(id.name, true) && validCodexPluginSegment(id.marketplace, false)
}

// validCodexPluginSegment is validate_plugin_segment: ASCII letters, digits,
// _ and -, and in a plugin name dots between non-empty parts.
func validCodexPluginSegment(s string, dots bool) bool {
	if s == "" || (dots && (strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") || strings.Contains(s, ".."))) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !isASCIIAlnum(c) && c != '-' && c != '_' && (!dots || c != '.') {
			return false
		}
	}
	return true
}

// validCodexPluginVersion is validate_plugin_version_segment.
func validCodexPluginVersion(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !isASCIIAlnum(c) && !strings.ContainsRune("-_.+", rune(c)) {
			return false
		}
	}
	return true
}

func isASCIIAlnum(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// codexActivePluginDir returns the install Codex runs of id, resolved, from
// cache (plugins/cache, resolved): of the version dirs that are real
// directories (not a symlink or junction) with a valid name, "local", else
// the highest by compareCodexPluginVersions. The listing counts against
// visits, and one that fills what is left of it is not used; the dir must
// resolve inside cache.
func codexActivePluginDir(cache *os.Root, cacheDir string, id codexPluginID, visits *int) string {
	left := commandsMaxVisited - *visits
	if left <= 0 {
		return ""
	}
	d := openRootDir(cache, path.Join(id.marketplace, id.name))
	if d == nil {
		return ""
	}
	entries, _ := d.ReadDir(left)
	d.Close()
	*visits += len(entries)
	if len(entries) == left {
		// The listing may be cut short, and its highest version missing.
		return ""
	}
	best := ""
	for _, e := range entries {
		v := e.Name()
		if !e.IsDir() || !validCodexPluginVersion(v) {
			continue
		}
		if v == "local" {
			best = v
			break
		}
		if best == "" || compareCodexPluginVersions(v, best) > 0 {
			best = v
		}
	}
	if best == "" {
		return ""
	}
	dir := resolvedDir(filepath.Join(cacheDir, id.marketplace, id.name, best))
	if dir == "" || !pathWithin(cacheDir, dir) {
		return ""
	}
	return dir
}

// compareCodexPluginVersions is compare_plugin_versions: by semver
// precedence, build metadata breaking a tie as the semver crate does, when
// both parse as semver, else bytewise. Codex sorts with it and takes the
// last; with mixed names that order is not total, and this takes the first
// highest in name order.
func compareCodexPluginVersions(a, b string) int {
	va, okA := parseSemver(a)
	vb, okB := parseSemver(b)
	if !okA || !okB {
		return strings.Compare(a, b)
	}
	for i := range 3 {
		if va.core[i] != vb.core[i] {
			if va.core[i] < vb.core[i] {
				return -1
			}
			return 1
		}
	}
	// A release is above its pre-releases; build metadata is the reverse.
	if c := compareSemverIDs(va.pre, vb.pre, true); c != 0 {
		return c
	}
	return compareSemverIDs(va.build, vb.build, false)
}

type semver struct {
	core       [3]uint64
	pre, build []string
}

// parseSemver parses a strict SemVer 2.0 version, as the semver crate does:
// no "v", no leading zeros in a number or a numeric pre-release identifier.
func parseSemver(s string) (semver, bool) {
	var v semver
	s, build, hasBuild := strings.Cut(s, "+")
	s, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil || (len(p) > 1 && p[0] == '0') {
			return v, false
		}
		v.core[i] = n
	}
	ids := func(s string, numeric bool) ([]string, bool) {
		out := strings.Split(s, ".")
		for _, id := range out {
			if id == "" {
				return nil, false
			}
			for i := 0; i < len(id); i++ {
				if !isASCIIAlnum(id[i]) && id[i] != '-' {
					return nil, false
				}
			}
			if numeric && isNumericID(id) && len(id) > 1 && id[0] == '0' {
				return nil, false
			}
		}
		return out, true
	}
	ok := true
	if hasPre {
		if v.pre, ok = ids(pre, true); !ok {
			return v, false
		}
	}
	if hasBuild {
		if v.build, ok = ids(build, false); !ok {
			return v, false
		}
	}
	return v, true
}

func isNumericID(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// compareSemverIDs orders dot-separated identifiers: numeric ones by value
// and below alphanumeric ones, which compare bytewise; a shorter list that is
// a prefix comes first. emptyHigh puts no identifiers above any (pre-release).
func compareSemverIDs(a, b []string, emptyHigh bool) int {
	if len(a) == 0 || len(b) == 0 {
		switch {
		case len(a) == len(b):
			return 0
		case (len(a) == 0) == emptyHigh:
			return 1
		default:
			return -1
		}
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		x, y := a[i], b[i]
		nx, ny := isNumericID(x), isNumericID(y)
		switch {
		case nx && ny:
			// By value: the longer is larger once leading zeros are gone.
			tx, ty := strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
			if c := compareInts(len(tx), len(ty)); c != 0 {
				return c
			}
			if c := strings.Compare(tx, ty); c != 0 {
				return c
			}
			if c := compareInts(len(x), len(y)); c != 0 {
				return c
			}
		case nx:
			return -1
		case ny:
			return 1
		default:
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
		}
	}
	return compareInts(len(a), len(b))
}

func compareInts(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// codexManifestStatus says what a manifest candidate holds.
type codexManifestStatus int

const (
	manifestMissing codexManifestStatus = iota // try the next candidate
	manifestFound
	manifestStop // Codex stops here: the plugin has no manifest
)

// codexPluginManifest reads the manifest of the plugin at dir (resolved) in
// Codex's order (find_plugin_manifest_path): plugin.json when its $schema is
// an agent-plugins.org one (an AgentPlugin), else .codex-plugin/,
// .claude-plugin/ then .cursor-plugin/plugin.json (Legacy). A candidate
// whose dir or file is a symlink or not a real dir or regular file ends the
// search. It returns the namespace and the skill dirs, relative to dir.
func codexPluginManifest(dir string, skip func(dir, rel string) bool) (string, []string, bool) {
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return "", nil, false
	}
	defer rt.Close()
	b, st := readPluginManifest(rt, dir, "plugin.json", skip)
	if st == manifestStop {
		return "", nil, false
	}
	if st == manifestFound {
		if head, ok := jsonObject(b, false); ok {
			var s string
			if json.Unmarshal(head["$schema"], &s) == nil && strings.HasPrefix(s, agentPluginSchemaPrefix) {
				ns, ok := parseAgentPluginManifest(b)
				return ns, []string{"skills"}, ok
			}
		}
	}
	for _, rel := range []string{".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"} {
		b, st := readPluginManifest(rt, dir, rel, skip)
		switch st {
		case manifestStop:
			return "", nil, false
		case manifestFound:
			return parseLegacyPluginManifest(b, dir)
		}
	}
	return "", nil, false
}

// readPluginManifest reads rel under rt when its dir is a real dir and it is
// a regular file of at most pluginJSONMax, not a symlink, that skip allows.
func readPluginManifest(rt *os.Root, dir, rel string, skip func(dir, rel string) bool) ([]byte, codexManifestStatus) {
	if parent := path.Dir(rel); parent != "." {
		fi, err := rt.Lstat(parent)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil, manifestMissing
		case err != nil || !fi.IsDir():
			return nil, manifestStop
		}
	}
	fi, err := rt.Lstat(rel)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, manifestMissing
	case err != nil || !fi.Mode().IsRegular() || fi.Size() > pluginJSONMax:
		return nil, manifestStop
	}
	if skip != nil && skip(dir, filepath.FromSlash(rel)) {
		return nil, manifestStop
	}
	f, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, manifestStop
	}
	defer f.Close()
	if got, err := f.Stat(); err != nil || !os.SameFile(got, fi) {
		return nil, manifestStop
	}
	b, err := io.ReadAll(io.LimitReader(f, pluginJSONMax))
	if err != nil {
		return nil, manifestStop
	}
	return b, manifestFound
}

// The one Agent Plugins schema Codex 0.164.0 supports, and the prefix that
// makes a root plugin.json an Agent Plugins manifest (plugin_namespace.rs).
const (
	agentPluginSchemaURI    = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
	agentPluginSchemaPrefix = "https://agent-plugins.org/schemas/"
)

// parseAgentPluginManifest checks a root plugin.json as
// agent_plugin_manifest.rs does and returns its name. Its skills are always
// in ./skills.
func parseAgentPluginManifest(b []byte) (string, bool) {
	m, ok := jsonObject(b, false)
	if !ok {
		return "", false
	}
	for _, k := range []string{"version", "description", "author", "homepage", "repository", "license"} {
		if isJSONNull(m[k]) {
			return "", false
		}
	}
	var schema, name string
	if json.Unmarshal(m["$schema"], &schema) != nil || schema != agentPluginSchemaURI ||
		json.Unmarshal(m["name"], &name) != nil || !validAgentPluginName(name) {
		return "", false
	}
	if !jsonOptStrings(m, "version", "description", "homepage", "repository", "license") || !jsonStringList(m, "keywords") {
		return "", false
	}
	if a, ok := m["author"]; ok {
		author, ok := jsonObject(a, false)
		if !ok {
			return "", false
		}
		for k, v := range author {
			if (k != "name" && k != "email" && k != "url") || isJSONNull(v) {
				return "", false
			}
		}
		if !jsonOptStrings(author, "name", "email", "url") {
			return "", false
		}
	}
	// The com.openai extension is read as a Legacy manifest.
	if ext, ok := jsonObject(m["extensions"], false); ok {
		if e, ok := ext["com.openai"]; ok && len(e) > 0 && e[0] == '{' && !validLegacyManifest(e) {
			return "", false
		}
	}
	return name, true
}

// validAgentPluginName is is_valid_agent_plugin_name.
func validAgentPluginName(s string) bool {
	if s == "" || len(s) > 64 || strings.Contains(s, "--") || strings.Contains(s, "..") {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return isASCIIAlnum(s[0]) && isASCIIAlnum(s[len(s)-1])
}

// parseLegacyPluginManifest reads the name and skills of a Legacy manifest
// (manifest.rs): the namespace is name, or the version dir's name when name
// is blank; skills is a "./" path or a list of them inside the plugin, the
// invalid ones dropped, with ./skills when none is left. The dirs come back
// sorted, without duplicates, at most codexPluginMaxSkillRoots of them.
func parseLegacyPluginManifest(b []byte, dir string) (string, []string, bool) {
	if !validLegacyManifest(b) {
		return "", nil, false
	}
	m, _ := jsonObject(b, true)
	var ns string
	json.Unmarshal(m["name"], &ns)
	if strings.TrimSpace(ns) == "" {
		ns = filepath.Base(dir)
	}
	var paths []string
	var one string
	if raw := m["skills"]; json.Unmarshal(raw, &one) == nil && !isJSONNull(raw) {
		paths = []string{one}
	} else if json.Unmarshal(raw, &paths) != nil {
		paths = nil
	}
	seen := map[string]bool{}
	var roots []string
	for _, p := range paths {
		if rel, ok := codexManifestPath(p); ok && !seen[rel] {
			seen[rel] = true
			roots = append(roots, rel)
		}
	}
	if len(roots) == 0 {
		roots = []string{"skills"}
	}
	sort.Strings(roots)
	if len(roots) > codexPluginMaxSkillRoots {
		roots = roots[:codexPluginMaxSkillRoots]
	}
	return ns, roots, true
}

// validLegacyManifest reports whether b decodes as Codex's
// RawPluginManifest: an object whose typed fields have their types. The
// shapes of mcpServers, hooks and interface.defaultPrompt are not checked.
func validLegacyManifest(b []byte) bool {
	m, ok := jsonObject(b, true)
	if !ok {
		return false
	}
	if !jsonString(m, "name") || !jsonOptStrings(m, "version", "description", "apps") || !jsonStringList(m, "keywords") {
		return false
	}
	if raw, ok := m["interface"]; ok && !isJSONNull(raw) {
		in, ok := jsonObject(raw, true)
		if !ok {
			return false
		}
		if !jsonOptStrings(in, "displayName", "shortDescription", "longDescription", "developerName", "category",
			"websiteUrl", "websiteURL", "privacyPolicyUrl", "privacyPolicyURL", "termsOfServiceUrl",
			"termsOfServiceURL", "brandColor", "composerIcon", "logo", "logoDark") ||
			!jsonStringList(in, "capabilities") || !jsonStringList(in, "screenshots") {
			return false
		}
	}
	return true
}

// jsonObject decodes a JSON object into its members, keys matched exactly
// as serde does (encoding/json would match "Name" to a name field). A key met
// twice keeps its last value, as in a serde_json Value, or with noDup refuses
// the object, as serde does decoding a struct.
func jsonObject(b []byte, noDup bool) (map[string]json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	m := map[string]json.RawMessage{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, false
		}
		k, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, false
		}
		if _, dup := m[k]; dup && noDup {
			return nil, false
		}
		m[k] = v
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	return m, true
}

func isJSONNull(raw json.RawMessage) bool { return string(raw) == "null" }

// jsonString reports whether key is absent or a string (not null).
func jsonString(m map[string]json.RawMessage, key string) bool {
	raw, ok := m[key]
	var s string
	return !ok || json.Unmarshal(raw, &s) == nil && !isJSONNull(raw)
}

// jsonOptStrings reports whether each key is absent, null or a string.
func jsonOptStrings(m map[string]json.RawMessage, keys ...string) bool {
	for _, k := range keys {
		if raw, ok := m[k]; ok && !isJSONNull(raw) && !jsonString(m, k) {
			return false
		}
	}
	return true
}

// jsonStringList reports whether key is absent or a list of strings, none
// of them null.
func jsonStringList(m map[string]json.RawMessage, key string) bool {
	raw, ok := m[key]
	if !ok {
		return true
	}
	var l []*string
	return !isJSONNull(raw) && json.Unmarshal(raw, &l) == nil && !slices.Contains(l, nil)
}

// codexManifestPath is resolve_manifest_path: "./" then a path that stays
// inside the plugin (no "..", not absolute). It returns the path cleaned,
// slash-separated.
func codexManifestPath(p string) (string, bool) {
	rel, ok := strings.CutPrefix(p, "./")
	if !ok || rel == "" {
		return "", false
	}
	seps := "/"
	if runtime.GOOS == "windows" {
		seps = `/\`
	}
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool { return strings.ContainsRune(seps, r) }) {
		if part == ".." {
			return "", false
		}
	}
	if !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", false
	}
	return path.Clean(filepath.ToSlash(rel)), true
}

// validCodexMention reports whether name can follow "$" in Codex's input
// (is_mention_name_char).
func validCodexMention(name string) bool {
	for i := 0; i < len(name); i++ {
		if c := name[i]; !isASCIIAlnum(c) && c != '_' && c != '-' && c != ':' {
			return false
		}
	}
	return name != ""
}

// readCodexPluginSkills lists the skills of the plugins config.toml enables
// that are installed under codexHome/plugins/cache, each named
// "<namespace>:<skill>", from one level of each skill dir (Codex walks a
// Legacy plugin's dirs deeper). At most commandsMaxPlugins plugins and
// commandsMaxPerSource skills are read, and the listings of every plugin
// share one commandsMaxVisited budget. Every file inside a plugin is read
// through an os.Root of its resolved dir, never through a symlink, and a
// symlinked skill dir may only lead elsewhere in its own plugin.
func readCodexPluginSkills(codexHome string, skip func(dir, rel string) bool) []agentCommand {
	if codexHome == "" {
		return nil
	}
	ids := codexEnabledPlugins(codexHome)
	if len(ids) == 0 {
		return nil
	}
	cacheDir := resolvedDir(filepath.Join(codexHome, "plugins", "cache"))
	if cacheDir == "" {
		return nil
	}
	cache, err := os.OpenRoot(cacheDir)
	if err != nil {
		return nil
	}
	defer cache.Close()
	visits := 0
	plugins := 0
	var out []agentCommand
	for _, id := range ids {
		if plugins == commandsMaxPlugins || visits >= commandsMaxVisited {
			break
		}
		dir := codexActivePluginDir(cache, cacheDir, id, &visits)
		if dir == "" {
			continue
		}
		plugins++
		ns, roots, ok := codexPluginManifest(dir, skip)
		if !ok || !validCodexMention(ns) {
			continue
		}
		opts := commandOpts{source: "plugin", prefix: ns + ":", allow: []string{dir}, skip: skip, visits: &visits}
		for _, rel := range roots {
			if skip != nil && skip(dir, filepath.FromSlash(rel)) {
				continue
			}
			for _, c := range readSkillDir(dir, rel, opts) {
				if validCodexMention(c.Name) {
					out = append(out, c)
				}
			}
			if len(out) >= commandsMaxPerSource {
				return out[:commandsMaxPerSource]
			}
		}
	}
	return out
}
