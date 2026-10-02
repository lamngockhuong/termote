package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Limits of the plugin listing, on top of the per-dir ones.
const (
	// commandsMaxPlugins caps the plugin dirs read.
	commandsMaxPlugins = 50
	// pluginJSONMax caps installed_plugins.json and the settings files read.
	pluginJSONMax = 1 << 20
)

// installedPlugins is the part of <claudeDir>/plugins/installed_plugins.json
// read here: each "<name>@<marketplace>" key has one entry per install.
type installedPlugins struct {
	Plugins map[string][]struct {
		InstallPath string `json:"installPath"`
		ProjectPath string `json:"projectPath"`
	} `json:"plugins"`
}

// pluginSettings is the part of a settings.json read here. A value that is
// not a boolean neither enables nor disables its plugin.
type pluginSettings struct {
	EnabledPlugins map[string]json.RawMessage `json:"enabledPlugins"`
}

// pluginDir is an enabled plugin's install, resolved inside <claudeDir>/plugins.
type pluginDir struct {
	name string
	dir  string
}

// readPluginCommands lists the commands and skills of the plugins enabled and
// installed for this pane, each named "<plugin>:<name>", at most
// commandsMaxPerSource in all.
func readPluginCommands(root, claudeDir string, skip func(dir, rel string) bool) []agentCommand {
	var out []agentCommand
	for _, p := range enabledPluginDirs(root, claudeDir) {
		// A symlinked skill dir may only lead elsewhere in its own plugin.
		opts := commandOpts{source: "plugin", prefix: p.name + ":", allow: []string{p.dir}, skip: skip}
		out = append(out, readCommandDir(p.dir, ".", opts)...)
		if len(out) >= commandsMaxPerSource {
			return out[:commandsMaxPerSource]
		}
	}
	return out
}

// enabledPluginDirs returns, in key order, the install dirs of the plugins
// that installed_plugins.json lists and enabledPlugins turns on: user scope
// (<claudeDir>/settings.json), then the project's .claude/settings.json and
// .claude/settings.local.json, a later scope overriding an earlier one. An
// install made for another project does not count, and neither does an
// installPath that does not resolve inside <claudeDir>/plugins: paths taken
// from the JSON are never followed anywhere else. The JSON files themselves
// sit at fixed paths and may be symlinks (dotfile managers link
// settings.json); only the fields above are read from them.
func enabledPluginDirs(root, claudeDir string) []pluginDir {
	base := resolvedDir(filepath.Join(claudeDir, "plugins"))
	if base == "" {
		return nil
	}
	var installed installedPlugins
	if !readJSONFile(filepath.Join(base, "installed_plugins.json"), &installed) {
		return nil
	}
	enabled := map[string]bool{}
	mergeEnabledPlugins(filepath.Join(claudeDir, "settings.json"), enabled)
	project := resolvedDir(root)
	if project != "" {
		mergeEnabledPlugins(filepath.Join(project, ".claude", "settings.json"), enabled)
		mergeEnabledPlugins(filepath.Join(project, ".claude", "settings.local.json"), enabled)
	}

	keys := make([]string, 0, len(installed.Plugins))
	for k := range installed.Plugins {
		if enabled[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var out []pluginDir
	for _, k := range keys {
		name, _, _ := strings.Cut(k, "@")
		if !validCommandName(name) || strings.Contains(name, ":") {
			continue
		}
		for _, inst := range installed.Plugins[k] {
			if inst.ProjectPath != "" && (project == "" || resolvedDir(inst.ProjectPath) != project) {
				continue
			}
			if dir := resolvedDir(inst.InstallPath); dir != "" && pathWithin(base, dir) {
				out = append(out, pluginDir{name: name, dir: dir})
				break
			}
		}
		if len(out) == commandsMaxPlugins {
			break
		}
	}
	return out
}

// mergeEnabledPlugins applies the enabledPlugins of the settings file p, when
// it can be read, over enabled.
func mergeEnabledPlugins(p string, enabled map[string]bool) {
	var s pluginSettings
	if !readJSONFile(p, &s) {
		return
	}
	for k, v := range s.EnabledPlugins {
		switch string(bytes.TrimSpace(v)) {
		case "true":
			enabled[k] = true
		case "false":
			enabled[k] = false
		}
	}
}

// readJSONFile decodes the regular file p into v. A file missing, larger
// than pluginJSONMax or not valid JSON reports false.
func readJSONFile(p string, v any) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > pluginJSONMax {
		return false
	}
	// A read cut short leaves JSON that does not decode.
	b, _ := io.ReadAll(io.LimitReader(f, pluginJSONMax))
	return json.Unmarshal(b, v) == nil
}
