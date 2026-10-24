# ADR-0002: Resolve only reachable engine names

Status: Accepted

Date: 2026-10-05. Orchestrator unit10; substrate Article6 and engine invariant: corrected toward Node at source.

The engine's dns.lookup returned IPv4 0.0.0.0 for every non-local name. Its
native TCP binding treats that wildcard as this host, so an unknown name
could reach an unrelated local listener. Node's lookup reports ENOTFOUND
when its host resolver has no address; it does not substitute a wildcard.
The reference is Node22.18's DNS contract:
https://github.com/nodejs/node/blob/v22.18.0/doc/api/dns.md.

The browser engine owns IP-literal and local-host lookup. Literals retain
their address and family; localhost resolves to the engine's IPv4/IPv6
loopback according to the caller's family/all selection. Other names fail
asynchronously with ENOTFOUND, syscall getaddrinfo and the requested hostname
in both callback and Promise doors. The engine has no outbound DNS service;
resource-record queries and reverse lookup fail explicitly instead of
fabricating wildcard, IPv6 loopback or localhost records.

The World owns vendor/name routing and its injector can wrap the process's
DNS door. The engine contains no vendor table or World-specific names.

The host that owns the tab's loopback can hold more names as this host than
`localhost`: the services of a stack it runs, its own host name. The engine
still keeps no table. The host installs its one at realm bootstrap
(`installHostNames`, the door `installNativeStreamTransport` is), and
`dns.lookup` asks it on every call: a held name resolves as `localhost` does,
to the loopback in the caller's family. `resolve`/`resolve4` and `resolve6`
answer a held name's loopback records (127.0.0.1, ::1), as the host's
resolver answers the same name to every other program in the tab; for every
other name, `localhost` included, record queries still fail. A name the host
does not hold is ENOTFOUND as before.
Raw TCP crosses native stream channels to the shared tab loopback; HTTP/fetch
crosses the substrate broker and World injector/proxy. A browser Fetch's own
external resolution does not grant the engine an external DNS service.
The World injector's separate documentation-address policy is recorded in
its owning architecture; unit10's routed-name reading must state its actual
route and answer.

Completion is the assigned page Shell lookup reading for localhost, a routed
World twin host, and no-such-host.invalid. No engine suite or standalone
check runs in this lane; artifact emission prepares the actual tab candidate.
