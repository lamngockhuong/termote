package main

import (
	"errors"
	"log"
	"net"
	"net/netip"
	"os/user"
	"sync"
	"time"
)

// A native server checks the OS user behind every connection made from this
// machine before it reads a byte of it: the boundary Termote relies on is
// the OS user, and without this check another user of the machine reaches
// the port with only the password in the way (nothing at all with
// --no-auth). The process at the client end must run as the server's user,
// root/SYSTEM (which can read the saved config anyway) or a user named with
// --allow-local-user (a reverse proxy). A connection from another machine
// (--lan) is not checked. macOS has no cheap way to see a connection's
// owner, so it checks nothing (peerOwner is nil there).

// errPeerNotFound means no live (ESTABLISHED) socket matches the client end
// of the connection: one closed already, or one the tables cannot show.
// Either way the connection is refused.
var errPeerNotFound = errors.New("no established socket for the connection")

// errPeerAbsent means the tables hold no socket at all for the client end
// (not even a closed one): a connection that came from another network
// stack, or a client socket aborted with a reset. Refused unless
// foreignLoopback confirms the first.
var errPeerAbsent = errors.New("no socket for the connection's client end")

// foreignPeerID stands for the client of a loopback connection that comes
// from another network stack sharing this one's loopback: Windows, under
// WSL 2 mirrored networking. Any Windows user's process can be one.
const foreignPeerID = "windows-host"

// foreignRecheckDelay separates the two looks at a connection whose client
// end is absent: a local client that aborts its socket (SO_LINGER 0) leaves
// the tables a moment before its reset reaches the server end, and past
// this delay that end is no longer established.
const foreignRecheckDelay = 10 * time.Millisecond

// errPeerRefused is what a refused connection's reads and writes return.
var errPeerRefused = errors.New("connection from another local user refused")

// errPeerTimeout means the lookup did not finish within peerLookupTimeout.
var errPeerTimeout = errors.New("peer lookup timed out")

const (
	// peerLookupSlots bounds the lookups running at once, so a flood of
	// connections cannot make the server read its socket tables in
	// parallel without end.
	peerLookupSlots = 4
	// peerLookupTimeout bounds the wait for a slot and the lookup: past it
	// the connection is refused.
	peerLookupTimeout = 2 * time.Second
	// machineAddrsMaxAge is how long the list of this machine's addresses
	// is kept; an address not in it is read again at most once per
	// machineAddrsMissEvery, so connections from other machines do not
	// make every accept list the interfaces.
	machineAddrsMaxAge    = 30 * time.Second
	machineAddrsMissEvery = time.Second
	// peerLogUsers bounds the users that get their own log rate limit; the
	// rest share one.
	peerLogUsers = 64
)

// localPeerCheck decides whether a connection may be served.
type localPeerCheck struct {
	// owner returns the user (uid, or SID on Windows) of the process
	// holding the client end of a connection from client to server.
	owner   func(client, server netip.AddrPort) (string, error)
	trusted map[string]bool
	// foreignLoopback accepts a loopback connection whose client end is
	// absent from this machine's tables while its server end stays
	// established (WSL 2: Windows reaching the server over the shared
	// loopback); false elsewhere.
	foreignLoopback bool
	// interfaceAddrs lists this machine's addresses (net.InterfaceAddrs).
	interfaceAddrs func() ([]net.Addr, error)
	slots          chan struct{}
	timeout        time.Duration

	addrMu    sync.Mutex
	addrs     map[netip.Addr]bool
	addrsRead time.Time

	logMu sync.Mutex
	logs  map[string]*peerLog
}

// peerLog is the log rate limit of one refused user, with its name read
// once.
type peerLog struct {
	rateLimitedLog
	name string
}

// newLocalPeerCheck returns the check of a native server, or nil when this
// OS cannot tell a connection's owner. allow names the extra users to trust;
// a name that no longer exists is logged and skipped.
func newLocalPeerCheck(allow []string) *localPeerCheck {
	if peerOwner == nil {
		return nil
	}
	trusted := map[string]bool{}
	for _, id := range trustedPeerIDs() {
		trusted[id] = true
	}
	// The id the OS gives this process, not os/user's: without cgo it cannot
	// name a directory (LDAP, SSSD) user, and the server's own user would
	// then be missing.
	trusted[selfPeerID()] = true
	for _, name := range allow {
		id, err := lookupLocalUser(name)
		if err != nil {
			log.Printf("allowed local user %q not found, skipped: %v", name, err)
			continue
		}
		trusted[id] = true
	}
	foreign := foreignLoopbackPossible()
	if foreign {
		trusted[foreignPeerID] = true
	}
	return &localPeerCheck{
		owner:           peerOwner,
		trusted:         trusted,
		foreignLoopback: foreign,
		interfaceAddrs:  net.InterfaceAddrs,
		slots:           make(chan struct{}, peerLookupSlots),
		timeout:         peerLookupTimeout,
		logs:            map[string]*peerLog{},
	}
}

// lookupLocalUser returns the id (uid, or SID on Windows) of a user named by
// --allow-local-user; a Unix uid given as a number is accepted too.
func lookupLocalUser(name string) (string, error) {
	u, err := user.Lookup(name)
	if err != nil {
		if u2, err2 := user.LookupId(name); err2 == nil {
			return u2.Uid, nil
		}
		return "", err
	}
	return u.Uid, nil
}

// listener wraps ln so every connection it accepts is checked on its first
// read or write. Accept itself never waits for a lookup: net/http accepts
// on one goroutine, and a lookup there would serialize every connection.
func (p *localPeerCheck) listener(ln net.Listener) net.Listener {
	return &peerCheckedListener{Listener: ln, check: p}
}

type peerCheckedListener struct {
	net.Listener
	check *localPeerCheck
}

func (l *peerCheckedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &peerCheckedConn{Conn: c, check: l.check}, nil
}

// peerCheckedConn runs the check once, on the connection's own goroutine,
// before the first byte is read or written.
type peerCheckedConn struct {
	net.Conn
	check *localPeerCheck
	once  sync.Once
	err   error
}

func (c *peerCheckedConn) verify() error {
	c.once.Do(func() {
		if !c.check.allows(c.Conn) {
			c.err = errPeerRefused
			c.Conn.Close()
		}
	})
	return c.err
}

func (c *peerCheckedConn) Read(b []byte) (int, error) {
	if err := c.verify(); err != nil {
		return 0, err
	}
	return c.Conn.Read(b)
}

func (c *peerCheckedConn) Write(b []byte) (int, error) {
	if err := c.verify(); err != nil {
		return 0, err
	}
	return c.Conn.Write(b)
}

// connAddrPort is a connection end as a plain address: IPv4-mapped IPv6
// unmapped, no zone, so ends written either way compare equal.
func connAddrPort(a net.Addr) (netip.AddrPort, bool) {
	t, ok := a.(*net.TCPAddr)
	if !ok {
		return netip.AddrPort{}, false
	}
	ap := t.AddrPort()
	return netip.AddrPortFrom(ap.Addr().Unmap().WithZone(""), ap.Port()), ap.IsValid()
}

// allows reports whether conn may be served, logging a refusal.
func (p *localPeerCheck) allows(conn net.Conn) bool {
	client, ok1 := connAddrPort(conn.RemoteAddr())
	server, ok2 := connAddrPort(conn.LocalAddr())
	if !ok1 || !ok2 {
		p.refused("", "no address", conn.RemoteAddr())
		return false
	}
	if !p.fromThisMachine(client.Addr()) {
		return true
	}
	id, err := p.lookup(client, server)
	if errors.Is(err, errPeerAbsent) && p.foreignLoopback && client.Addr().IsLoopback() && p.fromForeignStack(client, server) {
		id, err = foreignPeerID, nil
	}
	switch {
	case err != nil:
		p.refused("", err.Error(), conn.RemoteAddr())
		return false
	case !p.trusted[id]:
		p.refused(id, "other user", conn.RemoteAddr())
		return false
	}
	return true
}

// lookup runs owner within the timeout, in one of the slots. A lookup that
// outlives the timeout keeps its slot until it returns.
func (p *localPeerCheck) lookup(client, server netip.AddrPort) (string, error) {
	timer := time.NewTimer(p.timeout)
	defer timer.Stop()
	select {
	case p.slots <- struct{}{}:
	case <-timer.C:
		return "", errPeerTimeout
	}
	type result struct {
		id  string
		err error
	}
	done := make(chan result, 1)
	go func() {
		defer func() { <-p.slots }()
		id, err := p.owner(client, server)
		done <- result{id, err}
	}()
	select {
	case r := <-done:
		return r.id, r.err
	case <-timer.C:
		return "", errPeerTimeout
	}
}

// fromForeignStack confirms that a connection whose client end is absent
// is not a local client that just aborted its socket: the server end is
// established, and still is with the client end still absent a moment
// later, the wait spent outside the lookup slots.
func (p *localPeerCheck) fromForeignStack(client, server netip.AddrPort) bool {
	if _, err := p.lookup(server, client); err != nil {
		return false
	}
	time.Sleep(foreignRecheckDelay)
	if _, err := p.lookup(client, server); !errors.Is(err, errPeerAbsent) {
		return false
	}
	_, err := p.lookup(server, client)
	return err == nil
}

// fromThisMachine reports whether ip is a loopback address or one of this
// machine's own: a connection from another local user to the LAN address
// is as local as one to 127.0.0.1.
func (p *localPeerCheck) fromThisMachine(ip netip.Addr) bool {
	if ip.IsLoopback() {
		return true
	}
	p.addrMu.Lock()
	defer p.addrMu.Unlock()
	age := time.Since(p.addrsRead)
	if p.addrs == nil || age > machineAddrsMaxAge || !p.addrs[ip] && age > machineAddrsMissEvery {
		p.readAddrsLocked()
	}
	return p.addrs[ip]
}

func (p *localPeerCheck) readAddrsLocked() {
	p.addrsRead = time.Now()
	list, err := p.interfaceAddrs()
	if err != nil {
		// Keep the last list: a failed read must not make this machine's
		// own address count as another machine's.
		if p.addrs == nil {
			p.addrs = map[netip.Addr]bool{}
		}
		log.Printf("cannot list this machine's addresses: %v", err)
		return
	}
	addrs := map[netip.Addr]bool{}
	for _, a := range list {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok {
				addrs[ip.Unmap()] = true
			}
		}
	}
	p.addrs = addrs
}

// refused logs a refused connection as an audit line, at most once per
// rejectLogEvery for each user so one user's flood cannot hide another's.
// The first refusal of a user also says how to allow it.
func (p *localPeerCheck) refused(id, reason string, from net.Addr) {
	p.logMu.Lock()
	l, seen := p.logs[id]
	if !seen {
		if len(p.logs) < peerLogUsers {
			l = &peerLog{rateLimitedLog: rateLimitedLog{every: rejectLogEvery}}
			if id != "" {
				if u, err := user.LookupId(id); err == nil {
					l.name = u.Username
				}
			}
			p.logs[id] = l
		} else {
			l = p.logs["*"]
			if l == nil {
				l = &peerLog{rateLimitedLog: rateLimitedLog{every: rejectLogEvery}}
				p.logs["*"] = l
			}
			seen = true
		}
	}
	p.logMu.Unlock()
	name := l.name
	l.printf("%s", auditLine("local-user-refused", peerIDKey, id, "user", name, "reason", reason, "from", from.String()))
	if !seen && name != "" {
		log.Printf("a connection of local user %s was refused; if it is a reverse proxy you run, allow it with: termote start --allow-local-user %s", name, name)
	}
}
