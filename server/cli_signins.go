package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"text/tabwriter"
)

// signinIDRe is a sign-in's id as the server lists it.
var signinIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// maxSigninUAShown cuts a listed browser's User-Agent, in bytes.
const maxSigninUAShown = 60

var signinCallErrs = callErrs{
	noAuth:      "the server runs with --no-auth: nobody signs in, so there is nothing to list",
	unsupported: "the server runs with --no-auth: nobody signs in, so there is nothing to list",
	unknownCode: "unknown_session",
	unknownID:   "no browser is signed in with this id (list them: termote signins)",
	oldServer:   "the running server cannot list sign-ins; update it: termote update",
}

// cmdSignins lists the browsers signed in with the password, or signs one
// (or all) out.
func (c *cli) cmdSignins(args []string) error {
	var all bool
	fs := c.newFlagSet("signins")
	fs.BoolVar(&all, "all", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(pos) == 0 && !all:
		return c.listSignins()
	case len(pos) == 1 && pos[0] == "revoke" && all:
		return c.revokeAllSignins()
	case len(pos) == 2 && pos[0] == "revoke" && !all:
		return c.revokeSignin(pos[1])
	case len(pos) > 0 && pos[0] == "revoke", all:
		return usageError("usage: termote signins revoke <id>, or termote signins revoke --all")
	}
	return usageError("unknown signins command: %s (use: termote signins, termote signins revoke <id>|--all)", pos[0])
}

func (c *cli) listSignins() error {
	var res struct {
		Sessions []signinView `json:"sessions"`
	}
	if err := c.serverCall(c.deviceTarget(), http.MethodGet, "/api/mux/signins", nil, &res, signinCallErrs); err != nil {
		return err
	}
	c.heading("Signed-in browsers")
	if len(res.Sessions) == 0 {
		fmt.Fprintln(c.out, "  None.")
		fmt.Fprintln(c.out)
		return nil
	}
	const day = "2006-01-02 15:04"
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "  ID\tSIGNED IN\tLAST USED\tEXPIRES\tVIA\tFROM\tBROWSER")
	for _, s := range res.Sessions {
		if !signinIDRe.MatchString(s.ID) {
			return errors.New("unexpected answer from the server: a sign-in id is malformed")
		}
		// What a browser sent; never let it drive the terminal.
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.ID, s.CreatedAt.Local().Format(day), s.LastUsedAt.Local().Format(day),
			s.ExpiresAt.Local().Format(day), stripUnsafeRunes(s.Via), stripUnsafeRunes(s.IP), capBytes(stripUnsafeRunes(s.UserAgent), maxSigninUAShown))
	}
	tw.Flush()
	fmt.Fprintln(c.out, "\n  Sign one out: termote signins revoke <id>; every one: termote signins revoke --all")
	fmt.Fprintln(c.out)
	return nil
}

// warnPasswordKnown: a sign-out ends the cookie, not what the browser knows.
func (c *cli) warnPasswordKnown() {
	c.warnf("If the password may be known, run `termote start --fresh`: a browser that has it signs in again.")
}

// revokeSignin asks the running server to sign the browser id out, so its
// open terminals close at once.
func (c *cli) revokeSignin(id string) error {
	if !signinIDRe.MatchString(id) {
		return usageError("a sign-in id is 16 hex characters (list them: termote signins)")
	}
	var res struct {
		OK bool `json:"ok"`
	}
	if err := c.serverCall(c.deviceTarget(), http.MethodDelete, "/api/mux/signins/"+url.PathEscape(id), nil, &res, signinCallErrs); err != nil {
		return err
	}
	c.infof("Signed out browser %s: its open terminals are closed", id)
	c.warnPasswordKnown()
	return nil
}

// revokeAllSignins signs every browser out: the CLI has no session of its
// own to keep.
func (c *cli) revokeAllSignins() error {
	var res struct {
		OK      bool `json:"ok"`
		Revoked int  `json:"revoked"`
	}
	if err := c.serverCall(c.deviceTarget(), http.MethodDelete, "/api/mux/signins", nil, &res, signinCallErrs); err != nil {
		return err
	}
	c.infof("Signed out %s: their open terminals are closed", plural(res.Revoked, "browser"))
	c.warnPasswordKnown()
	return nil
}
