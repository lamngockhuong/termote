package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"
)

// settingsProposalRoute takes a proposal from the CLI over the local socket.
const settingsProposalRoute = "/api/mux/settings/proposal"

const settingsUsage = `usage: termote settings schema [--json]
       termote settings propose <json | ->`

// cmdSettings: the PWA settings an agent may propose. The user applies a
// proposal in the PWA, on each device; nothing changes without that.
func (c *cli) cmdSettings(args []string) error {
	if len(args) == 0 {
		return usageError(settingsUsage)
	}
	switch args[0] {
	case "schema":
		return c.settingsSchema(args[1:])
	case "propose":
		return c.settingsPropose(args[1:])
	}
	return usageError("unknown settings command: %s\n%s", args[0], settingsUsage)
}

func (c *cli) settingsSchema(args []string) error {
	asJSON := false
	fs := c.newFlagSet("settings schema")
	fs.BoolVar(&asJSON, "json", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError(settingsUsage)
	}
	if asJSON {
		_, err := c.out.Write(pwaSettingsSchemaJSON)
		return err
	}
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "KEY\tVALUES\tDEFAULT\tDESCRIPTION")
	for _, k := range pwaSettings.Keys {
		def, _ := json.Marshal(k.Default)
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", k.Key, settingValuesLabel(k), shortDefault(string(def)), k.Description)
	}
	tw.Flush()
	fmt.Fprintf(c.out, "\nSet on the device only, never proposed: %s\n", strings.Join(pwaSettings.DeviceOnly, ", "))
	fmt.Fprintln(c.out, "Propose with: termote settings propose '{\"editorVim\":true}' (the user applies it in the PWA)")
	return nil
}

// settingValuesLabel says in a few words what values a key takes.
func settingValuesLabel(k pwaSettingSpec) string {
	switch k.Type {
	case "enum":
		return formatValues(k.Values)
	case "integer":
		return fmt.Sprintf("%d-%d", *k.Min, *k.Max)
	case "string":
		return fmt.Sprintf("text, up to %d bytes", k.MaxBytes)
	case "names":
		return fmt.Sprintf("list of folder names, up to %d", k.MaxItems)
	case "shortcuts":
		return "{command: {key, inTerminal} | null}"
	}
	return "true, false"
}

func shortDefault(s string) string {
	if len(s) > 24 {
		return s[:21] + "..."
	}
	return s
}

// settingsProposalAnswer is the server's answer to a proposal.
type settingsProposalAnswer struct {
	ID        string            `json:"id"`
	ExpiresAt string            `json:"expiresAt"`
	Count     int               `json:"count"`
	Code      string            `json:"code"`
	Error     string            `json:"error"`
	Problems  []settingsProblem `json:"problems"`
}

// settingsPropose checks a proposal and hands it to the running server,
// over the local socket only: the route refuses everything else, so no
// password is ever sent (and --no-auth makes no difference).
func (c *cli) settingsPropose(args []string) error {
	if len(args) != 1 {
		return usageError(settingsUsage)
	}
	raw := []byte(args[0])
	if args[0] == "-" {
		var err error
		if raw, err = io.ReadAll(io.LimitReader(c.in, maxSettingsProposal+1)); err != nil {
			return fmt.Errorf("reading the proposal: %v", err)
		}
	}
	if _, problems := validateSettingsProposal(raw); problems != nil {
		c.printSettingsProblems(problems)
		return &exitError{code: 1}
	}
	saved, _ := c.loadConfig()
	if saved != nil && saved.Container != nil && c.installedSupervisor() == nil {
		return errors.New("settings propose is not supported in container mode (the container has no local socket); " +
			"apply the settings in the PWA instead, or move them with Settings > Export and Import")
	}
	port := c.savedPort(saved)
	resp, out := c.socketRequest(port, http.MethodPost, settingsProposalRoute, raw)
	switch out {
	case socketUnused:
		return fmt.Errorf("termote is not running on port %d (or not natively, with its local socket); start it: termote start", port)
	case socketMaybeSent:
		return errors.New(socketNoAnswerMsg)
	}
	defer resp.Body.Close()
	var ans settingsProposalAnswer
	json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&ans)
	switch {
	case resp.StatusCode == http.StatusOK && ans.ID != "":
	case ans.Code == "invalid_settings" && len(ans.Problems) > 0:
		c.printSettingsProblems(ans.Problems)
		return &exitError{code: 1}
	case ans.Code == "cli_only":
		return errors.New("the server takes a proposal only from the termote CLI over its local socket")
	case resp.StatusCode == http.StatusNotFound:
		return errors.New("the running server cannot take settings proposals; update it: termote update")
	case ans.Error != "":
		return fmt.Errorf("the server refused: %s", plainText(ans.Error))
	default:
		return fmt.Errorf("the server answered HTTP %d", resp.StatusCode)
	}
	expires := ans.ExpiresAt
	if t, err := time.Parse(time.RFC3339, ans.ExpiresAt); err == nil {
		expires = t.Local().Format("15:04")
	}
	c.infof("Proposed %s (id %s), waiting until %s", plural(ans.Count, "change"), ans.ID, expires)
	fmt.Fprintln(c.out, "Ask the user to open termote: each device shows the proposal and applies it there.")
	return nil
}

// plainText is s without control or hidden characters, for a line the
// server wrote.
func plainText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || hiddenRune(r) {
			return -1
		}
		return r
	}, s)
}

func (c *cli) printSettingsProblems(problems []settingsProblem) {
	for _, p := range problems {
		if p.Key == "" {
			c.errorf("%s", plainText(p.Reason))
		} else {
			c.errorf("%s: %s", plainText(p.Key), plainText(p.Reason))
		}
	}
}
