# Managed access (Orbit Node grants)

The target side of Orbit's "Managed grant revocation" contract (`docs/reference/conn.md` in
Orbit, Conn integration item 4). Code: `crates/conn-server/src/managed/`.

## What runs

`serve --managed-provision <file>` starts a second listener, the **managed ingress**. The file
and the service credential it names must be mode 0600 and owned by the server's user
(`managed/provision.rs` has the format). Its environment ID must equal this state directory's
environment ID, or the server exits. With managed provisioning the server prints no startup
pairing code; its native listener is the restricted fixture path.

| Part | File | Does |
| --- | --- | --- |
| Authority | `authority.rs` | Applied revision, lease, provisional and confirmed fenced sets, admitted edges, open handlers, owed ACKs. No I/O; every rule has a test. |
| Gateway | `gateway.rs` | `POST /api/v1/conn/managed/{authority,introspect,ack,realtime,broadcasting/auth}` over HTTPS that trusts the lab CA only. 2 s per call. |
| Notices | `notices.rs` | Reverb (Pusher protocol 7) on `private-conn-target.{id}.{generation}`, signed by the Gateway. A notice only restricts. |
| Ingress | `ingress.rs` | Managed tickets, `/ws`, shell and thread snapshots, a read-only preview of a provisioned tab. Everything else: 403. |
| Gate | `mod.rs`, `session.rs`, `routes/preview.rs` | One handler per socket, stream or request, registered before the upgrade. Checked before every dispatch and every frame; its close ends the socket. |

The probe runs every second, one at a time; a notice or a known later revision probes at
once. The lease ends 3 s after the send time of the last applied probe. A failed probe, a
wrong generation, a missing revision, an expired lease or a closed notice link fails closed
for all managed access. Recovery is a snapshot behind a barrier, with a live lease.

The `reader` profile: exactly `orchestration:read` and `terminal:read`, and the methods
`orchestration.subscribeShell`, `orchestration.subscribeThread`, `terminal.observe` and
`subscribeTerminalMetadata`. A managed token never falls through to native auth, and a
native credential is refused on the managed ingress.

## Lab measurements (loopback, fake Gateway, `cargo test managed -- --nocapture`)

| Case | Measured |
| --- | --- |
| Removal with notice: commit to client close | 0–1 ms |
| Removal with notice: commit to ACK (`observed`) | 1–2 ms |
| Notice dropped: commit to client close | about 990 ms (next probe) |
| Explicit authority failure: fault to fence | about 990 ms (next probe) |
| Silent partition: last confirmed probe to fence | about 3,000 ms (lease), never earlier than 2 s |

## Readings where the contract is open

Each is the fail-closed reading.

- A closed Reverb link is a "closed control connection": managed access fails closed and
  reopens only with the link up and a fresh snapshot.
- An introspection the Gateway cannot answer (transport, timeout, bad reply) is a failed
  check: fail closed. A 4xx refusal refuses only that caller.
- Every managed path needs a managed principal, including discovery and health.
- The "known test tab" is the provisioning's `previewTabs` list; empty refuses every preview.
- `peer_address` is the TCP peer's IP, IPv4-mapped addresses unwrapped.
- Realtime `url` must be `wss://` or `https://`; the socket path is `{url}/app/{key}`.
- An owed revision whose fence this process observed is acknowledged `observed`, also after
  a fail-closed recovery; `recovered` is only for revisions it did not see (a restart).

## Not proven here

The real Gateway, Reverb and lab CA (no lab Gateway yet: Orbit group 5870), the media fence
in a lab test (the preview needs a browser; the session gate tests cover its gate), terminal
streams in the lab (the lab has no terminal manager), and the NAT-mode proxy's caller
address. Legacy peer-link, held and device-paired credentials stay as they are on the native
ingress.
