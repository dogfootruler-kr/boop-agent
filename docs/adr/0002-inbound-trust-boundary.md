# Inbound trust boundary for gateway webhooks

## Status

accepted

## Context

`server/index.ts` rejects every request that is not loopback, except a small allowlist of public paths in `server/local-access.ts`.
That worked because the only inbound gateway was Sendblue, a cloud service that necessarily reaches Boop over the public internet.

The `whatsapp` channel is different in kind.
Its gateway, OpenWA, runs on hardware the user owns, on the same Tailscale tailnet as Boop.
Nothing about it needs to be publicly reachable.

This distinction is not obvious from the outside and was misread once during design, so it is recorded here.

## Decision

The WhatsApp webhook path is added to the public-path allowlist **and** additionally restricted to loopback or tailnet source addresses, and every call must carry the shared secret Boop registered with the Gateway, compared in constant time.
That secret is derived by HMAC from the Gateway API key rather than chosen by a human, but the check itself is a shared-secret comparison against a static header, not a signature verified over the payload.
Boop itself is not exposed to the public internet for WhatsApp.

The user's phone is never a party to any Boop connection.
It talks to WhatsApp's servers exactly as it always has; OpenWA talks to WhatsApp's servers; the only hop that touches the tailnet is OpenWA to Boop.
Consequently the WhatsApp channel requires *less* network exposure than the existing iMessage channel, not more.

## Considered alternatives

**Trusting the whole tailnet** by widening `isTrustedLocalRequest` was rejected.
It would expose `/chat`, `/agents/:id/retry`, and the WebSocket to anything on the tailnet, to make one webhook path reachable.

**HMAC alone on a public path** was rejected.
It would put the agent, its memory, and every connected integration behind a single shared secret with no network constraint in front of it.

**Exposing Boop publicly** so that a phone could reach it directly was considered and rejected as solving a problem that does not exist.

## Consequences

Sender allowlisting is enforced on the `whatsapp` channel only, in the shared inbound path, *before* the dedup claim, before anything is written to Convex, and before an agent is spawned.
It is checked in Boop even though OpenWA also filters at dispatch, because the security property must not depend on configuration living on a different machine.

The `sms` channel remains open to any sender.
This is a deliberate, informed choice, not an oversight.
Anyone who knows the Sendblue number gets a full agent turn with the user's memory and integrations attached.
Reopening it is reasonable; doing so silently under the impression that it was simply forgotten is not.

Because inbound handles are canonicalised to E.164 and the allowlist is matched on that form, an address that cannot be resolved to a phone number is never allowlisted and is always dropped.
This is the correct default, but it fails closed and therefore silently, so such drops are logged loudly.
