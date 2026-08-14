# Channel port for messaging transports

## Status

accepted

## Context

Boop was built around a single messaging transport and never named it.
`sendImessage` was imported directly by `server/interaction-agent.ts`, `server/automations.ts`, `server/proactive-email.ts`, and `server/sendblue.ts`, and the `sms:` conversation-ID prefix was hardcoded at four separate call sites.
Sendblue was not a module; it was an assumption spread across the server.

Adding WhatsApp forced the question, and Telegram is expected after it.

## Decision

Messaging transports are modelled as a **Channel** port: an interface with `send`, typing indication, outbound formatting, and a channel key.
Sendblue and OpenWA are adapters behind it.
Outbound routing is by the Conversation ID prefix, so the four existing call sites become one lookup.

Per-channel behaviour lives in the adapter, not in branches at the call site.
Outbound formatting is the clearest case: iMessage needs markdown stripped and 2900-character chunks, WhatsApp renders its own markup and accepts roughly 65,000 characters, so applying iMessage's rules to WhatsApp actively degrades the output.

Channels are deliberately **not** Integrations.
An Integration is a capability an execution agent uses to do work; a Channel is how the user reaches Boop at all.
They are registered, configured, and reasoned about separately, and the dispatcher never sees Channels as spawnable.

## Considered alternatives

Branching at each call site (`if (id.startsWith("wa:")) ... else ...`) was rejected.
It is cheaper for exactly one additional channel and worse for every one after, and its real failure is silent: a send path added later simply does not know new channels exist, and nothing fails to compile.

## Consequences

Phone-number redaction (`redactPhoneNumbers`) sits in the shared path *above* per-channel formatting, so no adapter can skip it.

Dedup moved with it: the Sendblue-specific `sendblueDedup` table was replaced by a `channelDedup` table keyed by channel and external message ID.
That table holds ephemeral claim markers with no historical value, so the migration was a cutover rather than a backfill.

Media ingestion deliberately did **not** move onto the port.
Sendblue serves media from unauthenticated CDN URLs; OpenWA requires an authenticated request addressed by chat and message ID.
These stay as two separate ingest functions sharing a plain helper for the parts that are genuinely identical: the streaming size cap, the MIME check, and the upload to Convex storage.
