package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Termote never runs cloudflared nor holds a tunnel token: the user runs the
// tunnel as a service, pointed at http://127.0.0.1:<port>. --cloudflare only
// names its hostname, so the server allows it as a Host, counts failed
// sign-ins per client by CF-Connecting-IP, and the CLI shows its URL and
// checks Cloudflare Access is in front of it.

// proxyFlags are the --cloudflare and --proxy-client-header flags start and
// container up share.
type proxyFlags struct {
	cloudflare    string
	noCloudflare  bool
	proxyHeader   string
	noProxyHeader bool
}

// add registers the flags on fs.
func (p *proxyFlags) add(fs *flag.FlagSet) {
	fs.StringVar(&p.cloudflare, "cloudflare", "", "")
	fs.BoolVar(&p.noCloudflare, "no-cloudflare", false, "")
	fs.StringVar(&p.proxyHeader, "proxy-client-header", "", "")
	fs.BoolVar(&p.noProxyHeader, "no-proxy-client-header", false, "")
}

// checkSet refuses a flag given together with the one that drops it.
func (p *proxyFlags) checkSet(set map[string]bool) error {
	if set["cloudflare"] && p.noCloudflare {
		return usageError("--cloudflare and --no-cloudflare cannot be combined")
	}
	if set["proxy-client-header"] && p.noProxyHeader {
		return usageError("--proxy-client-header and --no-proxy-client-header cannot be combined")
	}
	return nil
}

// merge keeps the saved value of a flag not given.
func (p *proxyFlags) merge(set map[string]bool, savedCloudflare, savedHeader string) {
	if !set["cloudflare"] && !p.noCloudflare {
		p.cloudflare = savedCloudflare
	}
	if !set["proxy-client-header"] && !p.noProxyHeader {
		p.proxyHeader = savedHeader
	}
}

// validate checks both values and refuses a Cloudflare hostname without
// auth: the tunnel opens the server to the Internet.
func (p *proxyFlags) validate(noAuth bool) error {
	if p.cloudflare != "" {
		p.cloudflare = strings.ToLower(p.cloudflare)
		if err := validCloudflareHost(p.cloudflare); err != nil {
			return usageError("%v", err)
		}
		if noAuth {
			return usageError("--cloudflare with --no-auth would open the terminal to the Internet without a password; drop one of them (--no-cloudflare, or --no-auth=false for a saved --no-auth)")
		}
	}
	if p.proxyHeader != "" {
		p.proxyHeader = canonicalProxyHeader(p.proxyHeader)
		if err := validProxyClientHeader(p.proxyHeader); err != nil {
			return usageError("invalid --proxy-client-header: %v", err)
		}
	}
	return nil
}

// header is the proxy client header in effect: the one set, else
// CF-Connecting-IP with a Cloudflare hostname, else none.
func (p *proxyFlags) header() string {
	return proxyClientHeader(p.cloudflare, p.proxyHeader)
}

// proxyClientHeader is the header the server reads the client's address
// from, given the saved Cloudflare hostname and --proxy-client-header.
func proxyClientHeader(cloudflare, header string) string {
	if header != "" {
		return header
	}
	if cloudflare != "" {
		return cloudflareClientHeader
	}
	return ""
}

// cloudflareHostRe is a DNS name of at least two labels: no port, scheme or
// path (Cloudflare serves the tunnel's hostname on 443 only).
var cloudflareHostRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`)

// validCloudflareHost checks a --cloudflare hostname (lower case).
func validCloudflareHost(h string) error {
	if len(h) > 253 || !cloudflareHostRe.MatchString(h) {
		return fmt.Errorf("invalid --cloudflare %q: give the tunnel's public hostname, such as term.example.com (no scheme, port or path)", h)
	}
	return nil
}

// cloudflareURL is the address a Cloudflare hostname serves the PWA on.
func cloudflareURL(host string) string {
	return "https://" + host
}

// accessState is what probing a Cloudflare hostname found in front of
// Termote.
type accessState string

const (
	accessOn      accessState = "on"      // Cloudflare Access answered
	accessOff     accessState = "off"     // Termote itself answered
	accessUnknown accessState = "unknown" // neither could be told
)

// accessResult is a probe's finding; Reason says why it is unknown.
type accessResult struct {
	State  accessState
	Reason string
}

// cloudflareProbeTimeout bounds one probe.
const cloudflareProbeTimeout = 5 * time.Second

// cloudflareProbeClient sends the probe: no cookie jar, never following a
// redirect (Access answers with one). Tests replace it.
var cloudflareProbeClient = &http.Client{
	Timeout:       cloudflareProbeTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// cloudflareProbeURL is where the probe of host goes. Tests replace it.
var cloudflareProbeURL = func(host string) string { return cloudflareURL(host) + "/api/mux/health" }

// cloudflareProbe is probeCloudflareAccess; tests replace it.
var cloudflareProbe = probeCloudflareAccess

// probeCloudflareAccess asks host, from outside, what stands in front of
// the server: an unauthenticated GET of the health route, with no password
// or cookie, read for its status and headers only.
func probeCloudflareAccess(ctx context.Context, host string) accessResult {
	ctx, cancel := context.WithTimeout(ctx, cloudflareProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cloudflareProbeURL(host), nil)
	if err != nil {
		return accessResult{accessUnknown, "bad hostname"}
	}
	req.Header.Set("User-Agent", "termote-cli/"+cliVersion+" (access check)")
	resp, err := cloudflareProbeClient.Do(req)
	if err != nil {
		return accessResult{accessUnknown, "not reachable"}
	}
	resp.Body.Close()
	return classifyAccess(resp)
}

// classifyAccess tells Cloudflare Access from Termote by the answer to an
// unauthenticated request. Access sends a browser to its sign-in page (a
// redirect to /cdn-cgi/access/login, as cloudflared's IsAccessResponse
// checks) and an OAuth client a 401 naming its protected-resource metadata;
// Termote asks for Basic auth. Anything else (403 of a blocking policy, 530
// while cloudflared is down) is unknown.
func classifyAccess(resp *http.Response) accessResult {
	switch resp.StatusCode {
	case http.StatusFound, http.StatusSeeOther:
		if u, err := resp.Location(); err == nil && strings.HasPrefix(u.Path, "/cdn-cgi/access/login") {
			return accessResult{accessOn, ""}
		}
		return accessResult{accessUnknown, "redirected elsewhere"}
	case http.StatusUnauthorized:
		for _, v := range resp.Header.Values("Www-Authenticate") {
			if strings.Contains(v, "cloudflare-access-protected-resource") {
				return accessResult{accessOn, ""}
			}
			if strings.HasPrefix(v, "Basic ") && strings.Contains(v, `realm="Terminal Access"`) {
				return accessResult{accessOff, ""}
			}
		}
	case http.StatusOK:
		return accessResult{accessOff, ""}
	}
	return accessResult{accessUnknown, "HTTP " + strconv.Itoa(resp.StatusCode)}
}

// reportCloudflareAccess probes host and says what it found: a loud warning
// when Termote answers the Internet itself. It never fails the command.
func (c *cli) reportCloudflareAccess(host string) accessResult {
	r := cloudflareProbe(context.Background(), host)
	switch r.State {
	case accessOn:
		c.infof("Cloudflare Access is on for %s", host)
	case accessOff:
		c.warnf("Cloudflare Access is OFF for %s: anyone on the Internet reaches the sign-in page,", host)
		c.warnf("  and the password is all that keeps them out of a shell on this machine.")
		c.warnf("  Add an Access application for this hostname: %s", cloudflareAccessDocs)
	default:
		c.infof("Could not tell whether Cloudflare Access is on for %s (%s); is cloudflared running?", host, r.Reason)
	}
	return r
}

// cloudflareAccessDocs is the guide to putting Access in front of the tunnel.
const cloudflareAccessDocs = "https://termote.ohnice.app/installation/cloudflare/"

// describeAccess is a probe's finding in a status line.
func describeAccess(r accessResult) string {
	if r.State == accessUnknown && r.Reason != "" {
		return string(r.State) + ", " + r.Reason
	}
	return string(r.State)
}
