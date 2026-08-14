# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on **`phoenix-error/boop-agent`** — this clone's `origin`, and a fork.

## Always pin the repo

This clone has two remotes: `origin` → `phoenix-error/boop-agent` (ours) and `upstream` → `raroque/boop-agent`.
GitHub CLIs resolve issue and PR commands to the **parent** repo by default in a fork, so an unpinned command reads and writes the wrong tracker.

**Every command below must carry `-R phoenix-error/boop-agent`**, and `gh-axi` requires flags to come *after* the command and its arguments — `gh-axi issue view 42 -R phoenix-error/boop-agent`, never `gh-axi -R … issue view 42`.
Never infer the repo from `git remote -v` here.

Use `gh-axi` for all GitHub operations, and fall back to raw `gh` / `gh api` only where `gh-axi` cannot express the call.

## Conventions

- **Create an issue**: `gh-axi issue create --title "..." --body "..." -R phoenix-error/boop-agent`. For multi-line bodies write the text to a file and use `--body-file <path>`.
- **Read an issue**: `gh-axi issue view <number> --comments --full -R phoenix-error/boop-agent`.
- **List issues**: `gh-axi issue list --state open --fields number,title,body,labels,comments -R phoenix-error/boop-agent`, adding `--label`, `--state`, `--assignee`, or `--author` filters as needed.
- **Comment on an issue**: `gh-axi issue comment <number> --body "..." -R phoenix-error/boop-agent` (or `--body-file <path>`).
- **Apply / remove labels**: `gh-axi issue edit <number> --add-label "..." -R phoenix-error/boop-agent` / `--remove-label "..."`.
- **Close**: `gh-axi issue close <number> --reason <completed|not_planned> --comment "..." -R phoenix-error/boop-agent`.
- **Create a missing label**: `gh-axi label create --name "..." --color "..." -R phoenix-error/boop-agent`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh-axi pr` equivalents:

- **Read a PR**: `gh-axi pr view <number> --comments -R phoenix-error/boop-agent` and `gh-axi pr diff <number> -R phoenix-error/boop-agent` for the diff.
- **List external PRs for triage**: `gh-axi pr list --state open -R phoenix-error/boop-agent`, then keep only authors whose association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`). Where `gh-axi` does not expose `authorAssociation`, fall back to `gh pr list -R phoenix-error/boop-agent --state open --json number,title,body,labels,author,authorAssociation,comments`.
- **Comment / label / close**: `gh-axi pr comment`, `gh-axi pr edit --add-label`/`--remove-label`, `gh-axi pr close` — each with a trailing `-R phoenix-error/boop-agent`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh-axi pr view 42 -R phoenix-error/boop-agent` and fall back to `gh-axi issue view 42 -R phoenix-error/boop-agent`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `phoenix-error/boop-agent`.

## When a skill says "fetch the relevant ticket"

Run `gh-axi issue view <number> --comments --full -R phoenix-error/boop-agent`.

## Sensitive data

This is a public repo, and so is its fork.
Issue bodies, comments, and titles are public the moment they are written.
Apply the same PII rules as commits — see the pre-commit checks section in `CLAUDE.md` — before publishing anything to the tracker.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh-axi issue create --label wayfinder:map -R phoenix-error/boop-agent`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue — `gh-axi issue subissue add <map> <child> -R phoenix-error/boop-agent`; list with `gh-axi issue subissue list <map> -R phoenix-error/boop-agent`. Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. No `gh-axi` wrapper exists, so use `gh api --method POST repos/phoenix-error/boop-agent/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/phoenix-error/boop-agent/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh-axi issue list --state open -R phoenix-error/boop-agent`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh-axi issue edit <n> --add-assignee @me -R phoenix-error/boop-agent` — the session's first write.
- **Resolve**: `gh-axi issue comment <n> --body "<answer>" -R phoenix-error/boop-agent`, then `gh-axi issue close <n> --reason completed -R phoenix-error/boop-agent`, then append a context pointer (gist + link) to the map's Decisions-so-far.
