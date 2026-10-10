package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// defaultPairValidity is how long a device `termote pair` makes stays
// signed in, unless --expires says otherwise.
const defaultPairValidity = "30d"

var validityRe = regexp.MustCompile(`^([0-9]{1,6})([hdw])$`)

// parseValidity reads --expires: a count of hours, days or weeks (12h, 7d,
// 2w), 1 hour to 400 days, or never (0).
func parseValidity(s string) (time.Duration, error) {
	if s == "never" {
		return 0, nil
	}
	m := validityRe.FindStringSubmatch(s)
	if m == nil {
		return 0, usageError("--expires takes a count and h, d or w (12h, 7d, 2w), or never")
	}
	n, _ := strconv.Atoi(m[1])
	unit := map[string]time.Duration{"h": time.Hour, "d": 24 * time.Hour, "w": 7 * 24 * time.Hour}[m[2]]
	// Compared before multiplying: a large count would wrap around.
	if n > int(maxDeviceValidity/unit) {
		return 0, usageError("--expires must be 1h to 400d, or never")
	}
	d := time.Duration(n) * unit
	if d < minDeviceValidity {
		return 0, usageError("--expires must be 1h to 400d, or never")
	}
	return d, nil
}

// validityLabel names how long a device stays signed in.
func validityLabel(secs int64) string {
	d := time.Duration(secs) * time.Second
	switch {
	case secs <= 0:
		return "never expires"
	case d%(24*time.Hour) == 0:
		return "valid for " + plural(int(d/(24*time.Hour)), "day") + " once used"
	}
	return "valid for " + plural(int((d+time.Hour-1)/time.Hour), "hour") + " once used"
}

func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	return strconv.Itoa(n) + " " + unit + "s"
}

// deviceTarget is the running server the device commands talk to: the
// native one, or the container when only that is set up. The link a code
// is shown with is built like `termote url` builds it: the server itself
// sees only 127.0.0.1.
type deviceTarget struct {
	port int
	user string
	pass string // empty with --no-auth or no saved password
	// noAuth: the target runs without sign-in, so it cannot pair devices.
	noAuth bool
	urls   accessURLs
}

func (c *cli) deviceTarget() deviceTarget {
	saved, _ := c.loadConfig()
	if saved != nil && saved.Container != nil && c.installedSupervisor() == nil {
		ct := saved.Container
		t := deviceTarget{port: ct.Port, user: saved.authUser(), noAuth: ct.NoAuth}
		if !ct.NoAuth {
			t.pass = saved.Password
		}
		t.urls = c.accessURLs(&savedConfig{LAN: ct.LAN, Tailscale: ct.Tailscale}, ct.Port)
		return t
	}
	t := deviceTarget{port: c.savedPort(saved), user: saved.authUser(), urls: c.accessURLs(saved, c.savedPort(saved))}
	if saved != nil {
		t.noAuth = saved.NoAuth
		if !saved.NoAuth {
			t.pass = saved.Password
		}
	}
	return t
}

// deviceCall sends method path (body as JSON when not nil) to the running
// server and decodes a 200 answer into out. Every other outcome is an error
// saying why, and the password never goes to a listener it cannot trust.
// Without a password nothing is asked: a server without sign-in cannot
// pair, and a listener whose owner was not checked could print anything.
func (c *cli) deviceCall(t deviceTarget, method, path string, body, out any) error {
	switch {
	case t.noAuth:
		return errors.New("pairing devices needs sign-in, and the server runs with --no-auth (turn it on: termote start --no-auth=false)")
	case t.pass == "":
		return errors.New("no saved password to sign in with; set one: termote start --fresh")
	}
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	resp, code := authedRequest(t.port, t.user, t.pass, method, path, data)
	if resp != nil {
		defer resp.Body.Close()
	}
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if resp != nil && code != http.StatusOK {
		json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&e)
	}
	switch {
	case code == http.StatusOK:
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
			return fmt.Errorf("unexpected answer from the server: %v", err)
		}
		return nil
	case code == 0:
		return fmt.Errorf("termote is not running on port %d; start it: termote start", t.port)
	case code == healthUntrusted:
		return errors.New(untrustedListenerMsg)
	case code == healthUnverified:
		return errors.New(unverifiedListenerMsg)
	case code == http.StatusUnauthorized:
		return errors.New("the server did not accept the saved password; restart it with it: termote restart")
	case code == http.StatusNotImplemented:
		return errors.New("pairing devices needs sign-in and a usable state dir: the server runs with --no-auth, or cannot use its devices dir (see: termote logs)")
	case e.Code == "unknown_device":
		return errors.New("no paired device has this id (list them: termote devices)")
	case code == http.StatusNotFound:
		return errors.New("the running server cannot pair devices; update it: termote update")
	case e.Error != "":
		return fmt.Errorf("the server refused: %s", cleanDeviceName(e.Error))
	}
	return fmt.Errorf("the server answered HTTP %d", code)
}

// shownPairCodeRe is a pairing code as the server shows it.
var shownPairCodeRe = regexp.MustCompile(`^[0-9A-Z]{5}-[0-9A-Z]{5}$`)

// roleLabel names a role for people.
func roleLabel(r role) string {
	if r == roleFull {
		return "full access"
	}
	return "view only"
}

// cmdPair makes a pairing code on the running server and shows it with a
// link and a QR code that pair the new device.
func (c *cli) cmdPair(args []string) error {
	var r, name, expires string
	fs := c.newFlagSet("pair")
	fs.StringVar(&r, "role", string(roleView), "")
	fs.StringVar(&name, "name", "", "")
	fs.StringVar(&expires, "expires", defaultPairValidity, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("pair takes no arguments (name the device with --name)")
	}
	if role(r) != roleView && role(r) != roleFull {
		return usageError("--role must be view or full")
	}
	if name != "" && !validDeviceName(name) {
		return usageError("--name must be 1-%d bytes, without control characters or spaces around it", maxDeviceName)
	}
	validFor, err := parseValidity(expires)
	if err != nil {
		return err
	}
	t := c.deviceTarget()
	var res struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
		ValidFor  int64     `json:"validFor"`
	}
	body := map[string]any{"role": r, "name": name}
	if validFor > 0 {
		body["validFor"] = int64(validFor / time.Second)
	}
	if err := c.deviceCall(t, http.MethodPost, "/api/mux/devices/pair", body, &res); err != nil {
		return err
	}
	if !shownPairCodeRe.MatchString(res.Code) {
		return errors.New("unexpected answer from the server: no pairing code")
	}
	base := t.urls.primary() + pairPath
	link := base + "?" + url.Values{"code": {res.Code}}.Encode()
	c.heading("Pair a device")
	fmt.Fprintf(c.out, "  Code: %s (%s, works once, until %s)\n", c.paint(ansiBold, res.Code), roleLabel(role(r)), res.ExpiresAt.Local().Format("15:04"))
	fmt.Fprintf(c.out, "  The device: %s.\n", validityLabel(res.ValidFor))
	fmt.Fprintf(c.out, "  Open on the new device: %s\n", link)
	fmt.Fprintf(c.out, "  Or open %s and type the code.\n\n", base)
	fmt.Fprint(c.out, qrText(link))
	return nil
}

// cmdDevices lists the paired devices, or revokes one.
func (c *cli) cmdDevices(args []string) error {
	pos, err := parseArgs(c.newFlagSet("devices"), args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(pos) == 0:
		return c.listDevices()
	case pos[0] == "revoke" && len(pos) == 2:
		return c.revokeDevice(pos[1])
	case pos[0] == "revoke":
		return usageError("usage: termote devices revoke <id>")
	}
	return usageError("unknown devices command: %s (use: termote devices, termote devices revoke <id>)", pos[0])
}

func (c *cli) listDevices() error {
	var res struct {
		Devices []deviceView `json:"devices"`
	}
	if err := c.deviceCall(c.deviceTarget(), http.MethodGet, "/api/mux/devices", nil, &res); err != nil {
		return err
	}
	c.heading("Paired devices")
	if len(res.Devices) == 0 {
		fmt.Fprintln(c.out, "  None. Pair one: termote pair")
		fmt.Fprintln(c.out)
		return nil
	}
	const day = "2006-01-02 15:04"
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "  ID\tNAME\tROLE\tPAIRED\tLAST USED\tVALID UNTIL\tPAIRED BY")
	for _, d := range res.Devices {
		if !deviceIDRe.MatchString(d.ID) {
			return errors.New("unexpected answer from the server: a device id is malformed")
		}
		until := "never"
		switch {
		case d.Expired:
			until = "expired"
		case d.ValidUntil != nil:
			until = d.ValidUntil.Local().Format(day)
		}
		// The names came from a person; never let them drive the terminal.
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\t%s\n", d.ID, cleanDeviceName(d.Name), roleLabel(d.Role),
			d.CreatedAt.Local().Format(day), d.LastUsedAt.Local().Format(day), until, pairedByLabel(d))
	}
	tw.Flush()
	fmt.Fprintln(c.out, "\n  Revoke one: termote devices revoke <id>")
	fmt.Fprintln(c.out)
	return nil
}

// pairedByLabel says where a listed device came from.
func pairedByLabel(d deviceView) string {
	switch {
	case d.PairedBy == pairedByPassword:
		return "not by a device"
	case d.PairedBy == "unknown" || d.PairedBy == "":
		return "unknown"
	case d.PairedByName != "":
		return cleanDeviceName(d.PairedByName)
	}
	return "a removed device"
}

// revokeDevice asks the running server to revoke id, and with it every
// device it paired, so their sessions and open streams end at once; the file
// is never edited behind its back.
func (c *cli) revokeDevice(id string) error {
	if !deviceIDRe.MatchString(id) {
		return usageError("a device id is 16 hex characters (list them: termote devices)")
	}
	t := c.deviceTarget()
	// Read first only to say what was revoked: a failure leaves the
	// names and the role unsaid.
	var list struct {
		Devices []deviceView `json:"devices"`
	}
	_ = c.deviceCall(t, http.MethodGet, "/api/mux/devices", nil, &list)
	var res struct {
		OK      bool     `json:"ok"`
		Revoked []string `json:"revoked"`
	}
	if err := c.deviceCall(t, http.MethodDelete, "/api/mux/devices/"+url.PathEscape(id), nil, &res); err != nil {
		return err
	}
	c.infof("Revoked device %s: it is signed out and its open terminals are closed", id)
	var also []string
	for _, g := range res.Revoked {
		if g == id || !deviceIDRe.MatchString(g) {
			continue
		}
		label := g
		for _, d := range list.Devices {
			if d.ID == g {
				label = g + " (" + cleanDeviceName(d.Name) + ")"
			}
		}
		also = append(also, label)
	}
	if len(also) > 0 {
		c.infof("Also revoked, as it paired them: %s", strings.Join(also, ", "))
	}
	for _, d := range list.Devices {
		if d.ID == id && d.Role == roleFull {
			c.warnf("A full device could open a terminal; to be sure, run `termote start --fresh`.")
		}
	}
	return nil
}

// pruneDevices removes from the disk the paired devices of the previous
// password, once start has saved a new one (they no longer sign in). The
// server is stopped then, so nothing else writes the store.
func (c *cli) pruneDevices(user, pass string) {
	dir := filepath.Join(c.stateDir(), "devices")
	if _, err := os.Stat(dir); err != nil {
		return
	}
	s, err := newDeviceStore(dir, user, pass)
	if err == nil {
		var n int
		if n, err = s.pruneStale(); err == nil && n > 0 {
			c.infof("Removed %d paired device(s) of the previous password", n)
		}
	}
	if err != nil {
		c.warnf("Could not remove the paired devices of the previous password (%v); they can no longer sign in", err)
	}
}
