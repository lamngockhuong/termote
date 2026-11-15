package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// An OpenCode pane's "/" commands and "@" skills are the service's own lists
// for the session's directory (command.list, skill.list): its built-ins, the
// config's and the project's. A message runs a command only when its name is
// in the list read right before the send, and attaches only the skills
// named there; any other "/name" or "@name" is the message's text.

const (
	// opencodeSkillsMax bounds skill.list's reply: it carries the whole
	// file of every skill (content), which is never decoded.
	opencodeSkillsMax = 16 << 20
	// opencodeMaxSkills bounds the skills one message attaches.
	opencodeMaxSkills = 16
)

// opencodeCommandInfo is a command as command.list gives it.
type opencodeCommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// opencodeSkillInfo is the part of a skill read: its id (what "@" names),
// its description and its path, to tell where it comes from. Its content
// (the skill's file) is not a field, so it is never kept.
type opencodeSkillInfo struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Path        string `json:"path"`
}

// opencodeLocation is the query naming a directory to the service.
func opencodeLocation(dir string) url.Values {
	return url.Values{"location[directory]": {dir}}
}

// sessionDir is the directory session id works in, as the service has it.
func (c *opencodeClient) sessionDir(ctx context.Context, id string) (string, error) {
	if !isOpencodeSessionID(id) {
		return "", errOpencodeNotFound
	}
	var res struct {
		Data struct {
			Location struct {
				Directory string `json:"directory"`
			} `json:"location"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/api/session/"+id, nil, opencodeSmallMax, &res); err != nil {
		return "", err
	}
	// The service's own path, only ever passed back to it.
	dir := res.Data.Location.Directory
	if dir == "" {
		return "", errors.New("opencode session: no directory")
	}
	return dir, nil
}

// commands lists the commands of dir, at most commandsMaxPerSource.
func (c *opencodeClient) commands(ctx context.Context, dir string) ([]opencodeCommandInfo, error) {
	var res struct {
		Data []opencodeCommandInfo `json:"data"`
	}
	if err := c.get(ctx, "/api/command", opencodeLocation(dir), opencodeSmallMax, &res); err != nil {
		return nil, err
	}
	var out []opencodeCommandInfo
	for _, cmd := range res.Data {
		if validCommandName(cmd.Name) && len(out) < commandsMaxPerSource {
			out = append(out, cmd)
		}
	}
	return out, nil
}

// skills lists the skills of dir, at most commandsMaxPerSource.
func (c *opencodeClient) skills(ctx context.Context, dir string) ([]opencodeSkillInfo, error) {
	var res struct {
		Data []opencodeSkillInfo `json:"data"`
	}
	if err := c.get(ctx, "/api/skill", opencodeLocation(dir), opencodeSkillsMax, &res); err != nil {
		return nil, err
	}
	var out []opencodeSkillInfo
	for _, s := range res.Data {
		if validCommandName(s.ID) && len(out) < commandsMaxPerSource {
			out = append(out, s)
		}
	}
	return out, nil
}

// opencodeSkillAttachment is a skill a message names: its id and where
// the "@id" stands in the text (UTF-16 units, as OpenCode's TUI counts).
type opencodeSkillAttachment struct {
	ID      string `json:"id"`
	Mention struct {
		Start int    `json:"start"`
		End   int    `json:"end"`
		Text  string `json:"text"`
	} `json:"mention"`
}

// runCommand runs command name of session id with text as its arguments,
// queued behind a running turn as a message is.
func (c *opencodeClient) runCommand(ctx context.Context, id, name, text string, files []opencodeAttachment, skills []opencodeSkillAttachment) error {
	if !isOpencodeSessionID(id) || !validCommandName(name) {
		return errOpencodeNotFound
	}
	body := map[string]any{"name": name, "text": text, "delivery": "queue"}
	if len(files) > 0 {
		body["files"] = files
	}
	if len(skills) > 0 {
		body["skills"] = skills
	}
	return c.send(ctx, http.MethodPost, "/api/session/"+id+"/command", body)
}

// opencodeAgentCommands is an OpenCode session's commands and skills as the
// Chat view lists them: names, descriptions on one line cut to
// commandDescMax, and where a skill comes from (OpenCode's own, the
// project's under dir, else the user's). A command's source is not given by
// the service: "custom", the built-ins being the PWA's own list.
func opencodeAgentCommands(dir string, cmds []opencodeCommandInfo, skills []opencodeSkillInfo) commandsResponse {
	out := make([]agentCommand, 0, len(cmds)+len(skills))
	desc := func(s string) string {
		return clipRunes(strings.Join(strings.Fields(stripANSI(s)), " "), commandDescMax)
	}
	for _, c := range cmds {
		out = append(out, agentCommand{Name: c.Name, Description: desc(c.Description), Source: "custom", Kind: "command"})
	}
	for _, s := range skills {
		source := "user"
		switch {
		case strings.HasPrefix(s.Path, "skill://"):
			source = "system"
		case pathWithin(dir, s.Path):
			source = "project"
		}
		out = append(out, agentCommand{Name: s.ID, Description: desc(s.Description), Source: source, Kind: "skill"})
	}
	return commandsResponse{Commands: out}
}

// opencodeCommands is the commands route for an OpenCode session: nothing
// for a view-only client (it runs none) or a session not made yet.
func (a *agentAPI) opencodeCommands(r *http.Request, s AgentSession) commandsResponse {
	none := commandsResponse{Commands: []agentCommand{}}
	if isViewOnly(r) {
		return none
	}
	res, err := a.commands.do("opencode\x00"+s.ID, func() (commandsResponse, error) {
		c, err := opencodeConnect()
		if err != nil {
			return none, err
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*opencodeTimeout)
		defer cancel()
		dir, err := c.sessionDir(ctx, s.ID)
		if err != nil {
			return none, err
		}
		cmds, err := c.commands(ctx, dir)
		if err != nil {
			return none, err
		}
		skills, err := c.skills(ctx, dir)
		if err != nil {
			return none, err
		}
		return opencodeAgentCommands(dir, cmds, skills), nil
	})
	if err != nil {
		if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode commands: %v", err)
		}
		return none
	}
	return res
}

// opencodeCommandRe is a message running a command: "/name", then its
// arguments after a space or a line break.
// Spaces are Unicode ones (\p{Z}), as the PWA reads them.
var opencodeCommandRe = regexp.MustCompile(`^/([^\s\p{Z}]+)(?:[\s\p{Z}]+|$)`)

// opencodeSkillRe finds "@name" words: at the start or after a space.
var opencodeSkillRe = regexp.MustCompile(`(?:^|[\s\p{Z}])@([\p{L}\p{N}][\p{L}\p{N}_.:-]*)`)

// opencodeMessagePlan is what a message sends: a command and its arguments
// (no name: a prompt), and the skills it names.
type opencodeMessagePlan struct {
	command string
	text    string
	skills  []opencodeSkillAttachment
	// whole and listed: the message and the skills read, to send it as
	// text after all.
	whole  string
	listed []opencodeSkillInfo
}

// planOpencodeMessage reads text against the session's lists: a "/name"
// at its start (lead, the text before any image) runs that command when
// it is listed; every listed "@name" attaches its skill once. An "@name"
// followed by punctuation (".", ":") names the skill without it.
func planOpencodeMessage(lead, text string, cmds []opencodeCommandInfo, skills []opencodeSkillInfo) opencodeMessagePlan {
	p := opencodeMessagePlan{text: text}
	// lead is the start of text: both lose the same spaces.
	if m := opencodeCommandRe.FindStringSubmatch(strings.TrimLeftFunc(lead, unicode.IsSpace)); m != nil {
		for _, c := range cmds {
			if c.Name == m[1] {
				t := strings.TrimLeftFunc(text, unicode.IsSpace)
				if !strings.HasPrefix(t, strings.TrimRightFunc(m[0], func(r rune) bool { return unicode.IsSpace(r) || unicode.Is(unicode.Z, r) })) {
					break // lead is not the start of text: sent as text
				}
				p.command = c.Name
				p.text = strings.TrimSpace(t[min(len(m[0]), len(t)):])
				break
			}
		}
	}
	known := map[string]bool{}
	for _, s := range skills {
		known[s.ID] = true
	}
	seen := map[string]bool{}
	for _, loc := range opencodeSkillRe.FindAllStringSubmatchIndex(p.text, -1) {
		name := p.text[loc[2]:loc[3]]
		for name != "" && !known[name] && strings.ContainsAny(name[len(name)-1:], ".:-_") {
			name = name[:len(name)-1]
		}
		if !known[name] || seen[name] || len(p.skills) >= opencodeMaxSkills {
			continue
		}
		seen[name] = true
		start := loc[2] - 1 // the "@"
		a := opencodeSkillAttachment{ID: name}
		a.Mention.Start = utf16Len([]byte(p.text[:start]))
		a.Mention.Text = "@" + name
		a.Mention.End = a.Mention.Start + utf16Len([]byte(a.Mention.Text))
		p.skills = append(p.skills, a)
	}
	return p
}

// planOpencodeSend reads what a message needs of session id's lists (the
// commands for a "/name" at its start, the skills for an "@name") and plans
// it. A session not made yet is errOpencodeNotFound; a command list that
// cannot be read is errOpencodeNoReply (the message meant a command). A
// skill list that cannot be read attaches no skill: "@" also names people,
// files and addresses, and such a message still goes.
func planOpencodeSend(ctx context.Context, c *opencodeClient, id, lead, text string) (opencodeMessagePlan, error) {
	plan := opencodeMessagePlan{text: text}
	command := opencodeCommandRe.MatchString(strings.TrimLeftFunc(lead, unicode.IsSpace))
	if !command && !opencodeSkillRe.MatchString(text) {
		return plan, nil
	}
	dir, err := c.sessionDir(ctx, id)
	if err != nil {
		return plan, err
	}
	var cmds []opencodeCommandInfo
	if command {
		if cmds, err = c.commands(ctx, dir); err != nil {
			log.Printf("opencode message: %v", err)
			return plan, errOpencodeNoReply
		}
	}
	var skills []opencodeSkillInfo
	if opencodeSkillRe.MatchString(text) {
		if skills, err = c.skills(ctx, dir); err != nil {
			log.Printf("opencode message: skills: %v", err)
			skills = nil
		}
	}
	plan = planOpencodeMessage(lead, text, cmds, skills)
	plan.whole, plan.listed = text, skills
	return plan, nil
}

// sendOpencodePlan sends plan: its command, or a prompt. A command the
// service no longer has (404 with the session there a moment ago) goes as
// the message's text, as an unlisted one does.
func sendOpencodePlan(ctx context.Context, c *opencodeClient, id string, plan opencodeMessagePlan, files []opencodeAttachment) error {
	if plan.command == "" {
		return c.prompt(ctx, id, plan.text, files, plan.skills)
	}
	err := c.runCommand(ctx, id, plan.command, plan.text, files, plan.skills)
	if !errors.Is(err, errOpencodeNotFound) {
		return err
	}
	text := planOpencodeMessage("", plan.whole, nil, plan.listed)
	return c.prompt(ctx, id, text.text, files, text.skills)
}
