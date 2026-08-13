# Context

The ubiquitous language of boop-agent.
Terms here are the canonical names.
When code, docs, or a commit message names one of these concepts, it uses the word defined here and not a synonym.

## Channel

A bidirectional messaging transport the user talks to Boop through.

A channel is identified by a short key that also serves as the prefix of every Conversation ID belonging to it.
The current keys are `sms` for Apple iMessage and `whatsapp` for WhatsApp.

`sms` is a slightly inaccurate name for a channel that is mostly iMessage.
It is kept because the Gateway behind it really does fall back to SMS for non-Apple recipients, and because renaming it would cost a data migration and buy nothing.

Do not call this an "integration".
An Integration is something an execution agent uses to get work done.
A channel is how the user reaches Boop in the first place.
They are different concepts and Boop's dispatcher treats them differently.

## Gateway

The external service that fronts a Channel and does the actual protocol work.

Sendblue is the gateway for the `sms` channel.
OpenWA is the gateway for the `whatsapp` channel.

Boop does not own a gateway's lifecycle.
A gateway is configured, reachable, and verified; it is not started or supervised by Boop.

## Handle

The user's address within a Channel.

A handle is always normalized to E.164 (`+4915112345678`), on every channel.
It is not the gateway's native address format.
WhatsApp's native format is a JID such as `628123456789@c.us`; that JID is reconstructed at send time and is not what Boop stores or compares.

A handle is the one and only form that appears in a Conversation ID.
Configuration may name a person in whichever form is convenient, including a raw JID, but an inbound address is always resolved to E.164 before it is matched or used to build a Conversation ID.
Without that rule the same person arriving under two address forms would accumulate two separate conversation histories.

An address that cannot be resolved to E.164 has no handle, and therefore no conversation.

## Conversation

A single thread between the user and Boop, identified by `<channel-key>:<handle>`.

For example `sms:+4915112345678` and `whatsapp:+4915112345678` are two distinct conversations with the same person.
Conversation ID is the routing key: it determines which Channel an outbound message goes out on.

## Allowlist

The set of Handles that Boop will accept an inbound message from **on the `whatsapp` channel**.

Anything not on the allowlist is dropped without a reply, without a stored message, and without spawning an agent.
The allowlist is a security boundary, not a filter or a preference.

The allowlist is per-channel, and deliberately not universal.
The `sms` channel has no allowlist and accepts a message from anyone who texts the number.
That is a known and accepted gap, not an oversight: read `docs/adr/0002-inbound-trust-boundary.md` before "fixing" it.

Boop is a single-user tool and the allowlist reflects that.
It is a flat set of handles with no notion of *who* a handle belongs to and no per-person permissions.
Admitting a second person is not an allowlist change: memory in Boop is globally unscoped, so a second person on the allowlist reads and writes the same memory store as the first.
