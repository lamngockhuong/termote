package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"rsc.io/qr"
)

// accessURLs are the addresses the native server answers on, from its saved
// config. They never carry the password.
type accessURLs struct {
	Local     string   `json:"local"`
	LAN       []string `json:"lan"`
	Tailscale string   `json:"tailscale"`
}

// primary is the URL another device most likely reaches: Tailscale, else the
// first LAN address, else this machine.
func (u accessURLs) primary() string {
	switch {
	case u.Tailscale != "":
		return u.Tailscale
	case len(u.LAN) > 0:
		return u.LAN[0]
	}
	return u.Local
}

func (c *cli) accessURLs(saved *savedConfig, port int) accessURLs {
	u := accessURLs{Local: fmt.Sprintf("http://localhost:%d", port), LAN: []string{}}
	if saved == nil {
		return u
	}
	if saved.LAN {
		for _, ip := range c.localIPv4s() {
			u.LAN = append(u.LAN, fmt.Sprintf("http://%s:%d", ip, port))
		}
	}
	if saved.Tailscale != "" {
		host, tsPort := splitTailscale(saved.Tailscale)
		u.Tailscale = "https://" + host
		if tsPort != "443" {
			u.Tailscale += ":" + tsPort
		}
	}
	return u
}

// statusReport is `termote status --json`: what the running server says and
// how it is reached. Its field names are a contract for scripts and the
// Herdr plugin.
type statusReport struct {
	Running bool `json:"running"`
	// Status is the server's own status ("ok"), else "unauthorized",
	// "untrusted listener" (another user holds the port), "unverified
	// listener" (something answers, its owner unseen), "http <code>" or
	// "not running". Running stays false for both listeners: no link to
	// them is opened or copied.
	// Version, Backend and PID are empty (0) unless the server answered.
	Status  string `json:"status"`
	Version string `json:"version"`
	Backend string `json:"backend"`
	PID     int    `json:"pid"`
	Port    int    `json:"port"`
	LAN     bool   `json:"lan"`
	Auth    bool   `json:"auth"`
	// Tailscale is the saved `host[:port]` ("" when not published).
	Tailscale  string     `json:"tailscale"`
	URLs       accessURLs `json:"urls"`
	Supervisor string     `json:"supervisor"`
}

func (c *cli) statusReport(saved *savedConfig, port int) statusReport {
	pass := ""
	r := statusReport{Port: port, Auth: true, URLs: c.accessURLs(saved, port)}
	if saved != nil {
		pass = saved.Password
		r.LAN, r.Auth, r.Tailscale = saved.LAN, !saved.NoAuth, saved.Tailscale
	}
	h, code := fetchHealth(port, saved.authUser(), pass)
	switch {
	case code == http.StatusOK:
		r.Running, r.Status, r.Version, r.Backend, r.PID = true, h.Status, h.Version, h.Backend, h.PID
	case code == http.StatusUnauthorized:
		r.Running, r.Status = true, "unauthorized"
	case code == healthUntrusted:
		r.Status = "untrusted listener"
	case code == healthUnverified:
		r.Status = "unverified listener"
	case code != 0:
		r.Status = "http " + strconv.Itoa(code)
	default:
		r.Status = "not running"
	}
	if sup := c.installedSupervisor(); sup != nil {
		r.Supervisor = sup.Name()
	}
	return r
}

func (c *cli) printStatusJSON(port int) error {
	saved, _ := c.loadConfig()
	if port == 0 {
		port = c.savedPort(saved)
	}
	r := c.statusReport(saved, port)
	enc := json.NewEncoder(c.out)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		return err
	}
	if !r.Running {
		return &exitError{code: 1}
	}
	return nil
}

// encodeURIComponent escapes s like JavaScript's encodeURIComponent, so a
// link matches the one the PWA writes back into the address bar.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if 'a' <= ch && ch <= 'z' || 'A' <= ch && ch <= 'Z' || '0' <= ch && ch <= '9' || strings.IndexByte("-_.!~*'()", ch) >= 0 {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// deepLink selects a session in the PWA; it is the Go twin of
// pwa/src/utils/deep-link.ts: #/s/<group>/<tab>[/<pane>][?view=<view>].
type deepLink struct{ group, tab, pane, view string }

func (l deepLink) hash() string {
	parts := []string{l.group, l.tab}
	if l.pane != "" {
		parts = append(parts, l.pane)
	}
	for i, p := range parts {
		parts[i] = encodeURIComponent(p)
	}
	h := "#/s/" + strings.Join(parts, "/")
	if l.view != "" && l.view != "terminal" {
		h += "?view=" + encodeURIComponent(l.view)
	}
	return h
}

// herdrContext reads the workspace, tab and pane a Herdr plugin command was
// invoked on: HERDR_PLUGIN_CONTEXT_JSON, the only one a popup gets and the
// one that describes this invocation, else the HERDR_*_ID variables, which a
// shell inside a Herdr pane also carries for its own pane.
func (c *cli) herdrContext() (deepLink, error) {
	var l deepLink
	if raw := c.getenv("HERDR_PLUGIN_CONTEXT_JSON"); raw != "" {
		var ctx struct {
			WorkspaceID   string `json:"workspace_id"`
			TabID         string `json:"tab_id"`
			FocusedPaneID string `json:"focused_pane_id"`
		}
		if json.Unmarshal([]byte(raw), &ctx) == nil {
			l = deepLink{group: ctx.WorkspaceID, tab: ctx.TabID, pane: ctx.FocusedPaneID}
		}
	}
	if l.group == "" || l.tab == "" {
		l = deepLink{group: c.getenv("HERDR_WORKSPACE_ID"), tab: c.getenv("HERDR_TAB_ID"), pane: c.getenv("HERDR_PANE_ID")}
	}
	if l.group == "" || l.tab == "" {
		return deepLink{}, errors.New("no Herdr workspace and tab found: run it from a Herdr plugin action or pane")
	}
	return l, nil
}

// linkInfo is the link to open and why it may not select the session.
type linkInfo struct {
	report statusReport
	url    string
	notes  []string
}

// resolveLink builds the URL of sel (no session when sel.group is empty) on
// the primary address. A Herdr link selects nothing unless the server runs
// the Herdr backend, whose ids it carries.
func (c *cli) resolveLink(sel deepLink, fromHerdr bool) linkInfo {
	saved, _ := c.loadConfig()
	r := c.statusReport(saved, c.savedPort(saved))
	info := linkInfo{report: r, url: r.URLs.primary() + "/"}
	switch {
	case sel.group == "":
	case fromHerdr && r.Backend != "" && r.Backend != "herdr":
		info.notes = append(info.notes, fmt.Sprintf("The server runs the %s backend, so the link opens its home screen (switch: termote start --mux herdr)", r.Backend))
	default:
		info.url += sel.hash()
	}
	return info
}

func (c *cli) cmdURL(args []string) error {
	var sel deepLink
	var fromHerdr, open, copyLink, showQR bool
	fs := c.newFlagSet("url")
	fs.BoolVar(&fromHerdr, "herdr", false, "")
	fs.StringVar(&sel.group, "group", "", "")
	fs.StringVar(&sel.tab, "tab", "", "")
	fs.StringVar(&sel.pane, "pane", "", "")
	fs.StringVar(&sel.view, "view", "", "")
	fs.BoolVar(&open, "open", false, "")
	fs.BoolVar(&copyLink, "copy", false, "")
	fs.BoolVar(&showQR, "qr", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("url takes no arguments (select with --herdr or --group/--tab/--pane)")
	}
	switch {
	case fromHerdr && (sel.group != "" || sel.tab != "" || sel.pane != ""):
		return usageError("--herdr reads the session from Herdr; leave out --group, --tab and --pane")
	case fromHerdr:
		view := sel.view
		l, err := c.herdrContext()
		if err != nil {
			return usageError("%v", err)
		}
		sel, sel.view = l, view
	case (sel.group == "") != (sel.tab == "") || sel.pane != "" && sel.tab == "":
		return usageError("--group and --tab go together, and --pane needs both")
	}
	info := c.resolveLink(sel, fromHerdr)
	if !info.report.Running {
		return errors.New("termote is not running; start it: termote start")
	}
	// stdout carries the link alone, so `$(termote url)` gets just that.
	for _, n := range info.notes {
		fmt.Fprintf(c.errOut, "%s %s\n", c.paint(ansiYellow, "[WARN]"), n)
	}
	fmt.Fprintln(c.out, info.url)
	if showQR {
		fmt.Fprint(c.out, qrText(info.url))
	}
	if copyLink {
		via, err := c.copyText(info.url)
		if err != nil {
			return err
		}
		fmt.Fprintf(c.errOut, "%s Copied the link (%s)\n", c.paint(ansiGreen, "[INFO]"), via)
	}
	if open {
		return c.openURL(info.url)
	}
	return nil
}

// qrText draws text as a QR code with half blocks, two modules per line.
// Light modules are drawn, so it reads on a dark terminal, with a two-module
// quiet zone; "" when text does not fit a QR code.
func qrText(text string) string {
	code, err := qr.Encode(text, qr.L)
	if err != nil {
		return ""
	}
	const quiet = 2
	light := func(x, y int) bool { return !code.Black(x, y) }
	var b strings.Builder
	for y := -quiet; y < code.Size+quiet; y += 2 {
		for x := -quiet; x < code.Size+quiet; x++ {
			top, bottom := light(x, y), light(x, y+1) && y+1 < code.Size+quiet
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// openURL opens url in the default browser, without a shell.
func (c *cli) openURL(url string) error {
	var openers [][]string
	switch c.goos {
	case "darwin":
		openers = [][]string{{"open"}}
	case "windows":
		openers = [][]string{{"rundll32", "url.dll,FileProtocolHandler"}}
	default:
		openers = [][]string{{"xdg-open"}, {"wslview"}}
	}
	var failed error
	for _, o := range openers {
		if _, err := c.run.LookPath(o[0]); err != nil {
			continue
		}
		// One that fails (xdg-open on WSL without a Linux browser) leaves
		// the next one to try.
		if err := c.run.RunQuiet("", o[0], append(o[1:], url)...); err != nil {
			failed = fmt.Errorf("%s could not open the browser: %v", o[0], err)
			continue
		}
		return nil
	}
	if failed != nil {
		return failed
	}
	return fmt.Errorf("no program to open a browser was found (looked for %s)", openers[0][0])
}

// copyText puts text on the clipboard: through the system's clipboard
// command, else OSC 52 when stdout is a terminal (it then reaches the
// clipboard of the terminal in front, also over SSH). via names the way.
func (c *cli) copyText(text string) (via string, err error) {
	var tools [][]string
	switch c.goos {
	case "darwin":
		tools = [][]string{{"pbcopy"}}
	case "windows":
		tools = [][]string{{"clip"}}
	default:
		tools = [][]string{{"wl-copy"}, {"xclip", "-selection", "clipboard"}, {"xsel", "--clipboard", "--input"}, {"clip.exe"}}
	}
	for _, t := range tools {
		if _, err := c.run.LookPath(t[0]); err != nil {
			continue
		}
		if c.run.RunQuiet(text, t[0], t[1:]...) == nil {
			return t[0], nil
		}
	}
	if c.outTTY {
		fmt.Fprintf(c.out, "\033]52;c;%s\a", base64.StdEncoding.EncodeToString([]byte(text)))
		return "through the terminal", nil
	}
	return "", errors.New("no clipboard command was found (wl-copy, xclip, xsel, pbcopy or clip)")
}
