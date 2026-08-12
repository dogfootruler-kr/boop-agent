# WhatsApp channel setup

This is the operator's guide to the `whatsapp` Channel: linking a WhatsApp session, running its Gateway (OpenWA), and configuring Boop to reach it.
Read this before you run `npm run setup` and choose to configure WhatsApp.

Two things are worth stating up front, because they are the point of the design.
**Your phone is never a party to any Boop connection.**
It talks to WhatsApp's own servers exactly as it always has, the same way WhatsApp Web or a second linked device does.
**Boop needs no public internet exposure for this feature.**
The only network hop that matters is OpenWA to Boop, and that hop stays on your Tailscale tailnet.

Every value in this guide is a placeholder.
Do not paste your real tailnet address, phone number, or API key into an issue, a commit, or anywhere else in this repo.

## Before you start

You need:

- **Tailscale**, installed and running on the machine that runs Boop, logged in ([tailscale.com/download](https://tailscale.com/download)).
- **Always-on hardware on the same tailnet** to run OpenWA on: a Raspberry Pi, a home server, a small VPS with Tailscale installed, anything that stays up.
  It does not have to be the machine running Boop, and in most setups it should not be, since Boop's own machine may not be always-on.
- **OpenWA itself**, the Gateway behind this Channel: [open-wa/wa-automate-nodejs](https://github.com/open-wa/wa-automate-nodejs).
  Follow its own instructions to run it with an HTTP API exposed, protected by an API key, and reachable from Boop's machine over the tailnet.
- **A WhatsApp account to link.**
  You do not need a second phone or a second number.
  You link your existing WhatsApp account as an additional linked device, the same way WhatsApp Web works, and your phone continues to work exactly as before.

## What Boop does and does not manage

Boop does not own OpenWA's lifecycle.
It never starts OpenWA, never supervises it, and never restarts it.
You run OpenWA yourself, on your own hardware, on your own schedule.

What Boop does own is everything on its side of that relationship: it configures itself to reach OpenWA, it verifies OpenWA is reachable and linked, and it registers where OpenWA should deliver inbound messages.
If OpenWA is down, Boop starts anyway, iMessage keeps working, and only the `whatsapp` Channel is degraded until OpenWA comes back and Boop is restarted.

## Step 1: Run OpenWA on your tailnet

Start OpenWA on your always-on hardware, following its own setup instructions, with:

- An HTTP API exposed and reachable at an address on your tailnet, for example `http://100.x.y.z:8080`.
- An API key configured, since Boop authenticates every request with one.
- A session identifier you choose, for example `boop`.
  You will give this same identifier to Boop in Step 3 as `WHATSAPP_SESSION_ID`.

Confirm Tailscale considers this machine part of your tailnet before moving on: `tailscale status` on the OpenWA host should list it, and the address you plan to use should look like `100.x.y.z` (Tailscale's IPv4 range) or the `fd7a:115c:a1e0::/48` IPv6 range.

## Step 2: Link the WhatsApp session (QR pairing)

This is the one step nothing in Boop can do for you, because it requires your phone.

1. With OpenWA running and the session from Step 1 not yet linked, it will present a QR code.
   Where exactly depends on how you chose to run OpenWA: some run modes print an ASCII QR code straight to the terminal or container logs, others serve it as an image over HTTP.
   Check OpenWA's own documentation for the run mode you picked if it is not obvious from its logs.
2. On the phone with the WhatsApp account you want Boop to use: open WhatsApp, go to **Settings → Linked Devices → Link a Device**, and scan the QR code.
3. OpenWA's logs should show the session moving to a connected state within a few seconds of the scan.
4. Verify it yourself against the Gateway's own API, using the base URL and API key from Step 1:

   ```
   curl -s http://100.x.y.z:8080/api/session/getConnectionState \
     -H 'x-api-key: <your-openwa-api-key>'
   ```

   A linked session reports `CONNECTED`.
   `OPENING`, `PAIRING`, or `UNLAUNCHED` are normal for the first few seconds after OpenWA starts; if it stays in one of those states, the link did not take and you should scan again.

Once linked, your phone's job is done.
It does not need to stay on WhatsApp Web, does not need any Boop-related app, and does not talk to Boop or to OpenWA at any point, before or after linking.
It talks to WhatsApp's servers, and WhatsApp's servers relay to OpenWA as an ordinary linked device.

## Step 3: Run `npm run setup`

Run `npm run setup` from the Boop checkout and choose to configure the WhatsApp channel when asked.
It collects:

- **Gateway base URL** - OpenWA's root URL on your tailnet, without a trailing `/api`, e.g. `http://100.x.y.z:8080`.
- **Gateway API key** - the one you configured OpenWA with in Step 1.
- **Session identifier** - the same one you gave OpenWA in Step 1, e.g. `boop`.
- **Allowlist** - who may message Boop on WhatsApp.
  See the Allowlist section below before filling this in.
- **Self-address override** (optional) - the Gateway account's own WhatsApp address, written as E.164 or as a `@c.us` JID.
  Setting it makes Boop drop any inbound message whose sender resolves to that address, as a second guard beside the Gateway's own "this message is mine" flag.
  Leaving it blank changes nothing about how Boop behaves today.
  See "A self-reply loop" under Troubleshooting for when it earns its keep.
- **Proactive notice channel** - where Boop reaches you when it starts the conversation itself, rather than replying to something you sent.
  See "Proactive notices on WhatsApp" below.

Setup also works out Boop's own tailnet address automatically, by asking the local Tailscale node running on this machine.
You are not asked to find or type a MagicDNS name yourself.
If Tailscale cannot answer - not installed, not running, not logged in - setup fails loudly and offers to let you type the address by hand, or you can set `BOOP_TAILNET_ADDRESS` in `.env.local` yourself and re-run setup.

Setup does **not** ask you for a webhook secret.
See the next section for why.

## Step 4: What happens automatically at startup

Every time Boop starts with WhatsApp configured, it does three things by itself, with no API call for you to make:

1. **Discovers its own tailnet address** (or reuses your `BOOP_TAILNET_ADDRESS` override), so OpenWA knows where to deliver inbound messages.
2. **Generates the webhook signing secret**, derived from `WHATSAPP_API_KEY` rather than chosen by you.
3. **Registers the webhook with OpenWA**, idempotently: if OpenWA already has exactly the webhook Boop wants, nothing is sent; if something changed - a new tailnet address, a rotated key, an updated Allowlist - the existing registration is updated in place rather than duplicated.

You will see this in Boop's startup logs, prefixed `[whatsapp]`.
A successful run looks roughly like:

```
[whatsapp] session boop is CONNECTED - the gateway is linked to WhatsApp
[whatsapp] the gateway already delivers to http://100.x.y.z:3456/whatsapp/webhook - nothing to register
```

or, on a first run:

```
[whatsapp] registered http://100.x.y.z:3456/whatsapp/webhook with the gateway for message.received
```

## Rotating the API key

The webhook signing secret is not a separate value you set anywhere.
It is derived from `WHATSAPP_API_KEY` by Boop itself, so nothing has to be typed or stored on either side.

The consequence: **rotating `WHATSAPP_API_KEY` also rotates the signing secret.**
Update `.env.local` with the new key, then restart Boop so it re-registers the webhook with OpenWA under the new secret.
Until you restart, OpenWA still holds the old secret and WhatsApp messages will stop arriving, since Boop will reject a webhook call signed with a secret derived from a key it no longer has.

## Proactive notices on WhatsApp

Most of what Boop sends is a reply, and a reply goes back on the channel the message came in on, so there is nothing to configure.
Two things are not replies: a proactive notice about an urgent email, and an automation result.
Those have no inbound message to answer, so Boop has to be told where to send them.

`BOOP_PROACTIVE_CHANNEL` in `.env.local` is that setting.
Leave it blank for iMessage, which is what happens if you never touch it, or set it to `whatsapp`:

```
BOOP_USER_PHONE=+15550000101
BOOP_PROACTIVE_CHANNEL=whatsapp
```

It is the same phone number either way, since a handle is E.164 on every channel.
`BOOP_USER_PHONE` is what says *who*, and this setting is what says *where*; without the number set, notices are dropped and logged whichever channel you pick.

Set this to `whatsapp` only once the WhatsApp channel above actually works, since a notice has nowhere to go on a channel with no Gateway configured.
When that happens Boop logs it and does **not** record the message, so what the debug dashboard shows stays honest about what you received.

Automations are unaffected by this setting.
An automation notifies on the conversation you created it in, so one you set up over WhatsApp reports back over WhatsApp.

## The Allowlist

`WHATSAPP_ALLOWLIST` is a security boundary, not a preference.
Anything not on it is dropped without a reply, without a stored message, and without spawning an agent.

Write each entry as either:

- **E.164**, e.g. `+15550000101`, or
- **a raw JID**, e.g. `15550000101@c.us`.

Both forms normalize to the same Handle, so use whichever is convenient.
Separate multiple entries with a comma, a semicolon, or a newline - not a space, since a phone number like `+1 (555) 000-0101` is written with spaces in it and splitting on them would mangle it.

A group JID (`@g.us`) or an unresolved WhatsApp-internal id (`@lid`) is rejected at load time, not just at admission: an Allowlist is a set of people, and a `@lid` entry can only be resolved with a live Gateway call, which would make the Allowlist load correctly only when OpenWA happens to be up.

Boop's memory is not scoped per person.
Adding a second entry does not give that person their own space - they read and write the same memory store as everyone else on the Allowlist.
Treat this as a single-user Allowlist unless you have separately solved that problem.

## When a session un-pairs itself

WhatsApp can log out a linked device on its own, for two reasons: the phone stays offline too long, or you (or WhatsApp) remove the device from the phone's Linked Devices screen.

When that happens, **Boop looks completely healthy**.
The server is up, iMessage keeps working, OpenWA answers Boop's requests normally, and webhook registration still succeeds - it is just registering against a session that is no longer linked to anything.
Nothing on a dashboard will tell you this, because there is deliberately no dashboard surface for WhatsApp.
The only place the cause is visible is Boop's own startup logs.

Grep for `[whatsapp]` in the server logs after a restart.
A healthy session logs:

```
[whatsapp] session boop is CONNECTED - the gateway is linked to WhatsApp
```

An un-paired one logs something like, where `<state>` is whatever OpenWA reports for a session that is not connected and not still coming up:

```
[whatsapp] session boop is <state> - the gateway is NOT linked to WhatsApp
[whatsapp] → no inbound WhatsApp message can arrive in this state, and nothing else will say so: Boop stays healthy, replies on iMessage, and simply goes quiet on WhatsApp.
[whatsapp] → a session un-pairs on its own when the linked phone stays offline too long, or when the device is removed from WhatsApp's linked-devices screen.
[whatsapp] → fix it where the gateway runs, by scanning its QR code again. Boop never starts, supervises, or restarts the gateway.
```

Boop reads any Gateway-reported state other than `CONNECTED` (linked) or `OPENING` / `PAIRING` / `UNLAUNCHED` (still coming up) as not linked, so the exact wording OpenWA uses for "un-paired" is not one Boop's own code chooses.

The fix is Step 2 again: go back to OpenWA, get a fresh QR code, and scan it from your phone.
Boop will pick the re-linked session up on its next restart, since that is when it reads and logs session state.

## The Gateway is not an official WhatsApp API

OpenWA is a reverse-engineered WhatsApp client.
It is not an API WhatsApp publishes or supports, and using it carries real account-suspension risk that is yours to carry, not Boop's.

This is why the WhatsApp adapter in Boop is kept deliberately thin: three HTTP calls, nothing built on an OpenWA-specific feature, so the Gateway is replaceable if it ever needs to be.
If you are not comfortable with that risk on the WhatsApp account you plan to link, consider linking a secondary or less critical number instead of your primary one.

## Troubleshooting

### Tailscale is not running

`npm run setup` and Boop's own startup both fail loudly here rather than silently, because a wrong or missing tailnet address means OpenWA cannot deliver anything and your first message vanishes with no explanation.
You will see a message like:

```
Could not reach the local Tailscale node (`tailscale status --json` failed).
```

Fix: install Tailscale, make sure it is running and logged in (`tailscale up`) on the machine running Boop, then re-run setup or restart Boop.
Alternatively, set `BOOP_TAILNET_ADDRESS` in `.env.local` to skip the check entirely - useful if you are on a Tailscale setup Boop's automatic query cannot see, such as a subnet router.

### Gateway unreachable at startup

If OpenWA is down, unreachable, or rejects Boop's request when Boop starts, you will see:

```
[whatsapp] webhook registration failed: <reason>
[whatsapp] → Boop is running and iMessage is unaffected, but no WhatsApp message will arrive until the gateway is reachable and Boop has been restarted.
```

Boop does not retry this in the background, since it does not supervise OpenWA's lifecycle.
Fix: confirm OpenWA is actually running on the hardware you set it up on, confirm `WHATSAPP_GATEWAY_URL` and `WHATSAPP_API_KEY` in `.env.local` are correct, confirm the Boop machine can reach that tailnet address at all (`curl` the URL from Step 2 directly), then restart Boop.

### Messages are silently dropped

Two distinct causes look similar from the outside - a message you expected never produces a reply - and both are logged loudly on purpose, because this failure mode has no other visible signal.

**Sender could not be resolved to a Handle.**
WhatsApp delivered an address Boop could not turn into an E.164 phone number.
Grep for `DROPPED` in the server logs:

```
[whatsapp] DROPPED an inbound message: sender address <8 digits>@lid could not be resolved to a Handle (E.164). Nothing was stored and no agent ran.
```

The logged shape (digit count, suffix) is deliberately not the real number, since these logs get pasted into issues in a public repo.
If this happens for a sender you expect to be reachable, it usually means OpenWA's contact lookup could not resolve their `@lid` to a phone number; there is no fix on Boop's side beyond that lookup succeeding.

**The sender was the Gateway's own account.**
Only possible when you set `WHATSAPP_SELF_ADDRESS`, and only for a message the Gateway did not flag as its own.
Grep for `self-reply loop`:

```
[whatsapp] dropped a message whose sender is the gateway's own address, and which the gateway did not flag as its own - WHATSAPP_SELF_ADDRESS is the only thing standing between this and a self-reply loop
```

See "A self-reply loop" below.

**Sender resolved fine but is not on the Allowlist.**
Grep for `not on the allowlist`:

```
[whatsapp] refused a message from <10 digits>@c.us: not on the allowlist
```

Fix: add the sender's number to `WHATSAPP_ALLOWLIST` in `.env.local` (E.164 or JID, see the Allowlist section above) and restart Boop.
Group messages are always refused regardless of the Allowlist and do not produce this specific log line - being added to a group must not turn every message in it into an agent turn.

### A self-reply loop

You linked your own WhatsApp account to the Gateway, so the Gateway's own address is the one you put on the Allowlist.
Every reply Boop sends therefore comes back to the webhook from a sender Boop is configured to accept.

The only thing that normally stops that from becoming reply-webhook-reply-webhook forever is the Gateway flagging its own messages as its own, which OpenWA does.
If a Gateway version or an echo path ever stops doing that, the loop is unbounded and expensive.

`WHATSAPP_SELF_ADDRESS` is the second guard.
Set it to the Gateway account's own address and Boop drops anything from that sender, flagged or not:

```
WHATSAPP_SELF_ADDRESS=+15550000101
```

It is optional and off by default: leave it blank and Boop behaves exactly as it does today.
Set it if the Gateway account and an Allowlist entry are the same account, which is the common single-account setup.
Note that this is a drop, not a filter on your own messages arriving from elsewhere: a message you send Boop from that same account is indistinguishable from Boop's own echo, so if you talk to Boop from the linked account itself, leave this blank.
