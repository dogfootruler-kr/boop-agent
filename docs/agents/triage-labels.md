# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Which of these exist today

Of the five, only `wontfix` already exists on `phoenix-error/boop-agent`.
The other four are created on first use:

```
gh-axi label create --name needs-triage --color d93f0b -R phoenix-error/boop-agent
```

Check the current set with `gh-axi label list -R phoenix-error/boop-agent` before assuming a label is present.
Note that `gh-axi` requires flags to come after the command, and that `-R` is mandatory here — see `docs/agents/issue-tracker.md`.
