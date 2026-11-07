---
name: dsh-superagent-gerrit
description: Submit patches to Gerrit for review, and answer the reviewers of a change.
---

Gerrit is the code review server of this installation. A patch is submitted by pushing it to the review server, and reviewers answer on the change itself.

Read changes with orchestrator_read: `gerrit/changes/<number>` for the change, `gerrit/changes/<number>/comments` for its review comments, `gerrit/changes/<number>/messages` for its change messages. A change reads as `{ number, id, project, branch, subject, status, owner, updated, url, message, labels }`; `message` is the commit message, which names the task the change answers.

## Submitting a patch

Nothing prepared a checkout for you: the ticket's directory is empty, and the project is the Gerrit project. Clone it into that directory first.

```sh
git clone "$DSH_SUPERAGENT_GERRIT_SSH_URL" .
```

The variable carries the project, such as `ssh://agent@host:29418/demo`. The clone reaches the server with the key the Gerrit Source names, because dsh-superagent writes `core.sshCommand` into the worker's git configuration.

Then four things make the push land as a reviewable change.

1. Commit on a branch named after the ticket.

   ```sh
   git switch -c "agent/$DSH_SUPERAGENT_NAME"
   ```

2. The commit needs a `Change-Id` trailer; Gerrit rejects a change without one.

   ```sh
   CHANGE_ID="I$(openssl rand -hex 20)"
   ```

3. The commit message names the task, so the change and the issue can be correlated: add `Issue: <issue number>` — `$DSH_SUPERAGENT_REDMINE_ISSUE_ID` when the ticket came from Redmine.

   ```sh
   git commit -m "Fix the login redirect" \
     -m "Issue: $DSH_SUPERAGENT_REDMINE_ISSUE_ID" \
     -m "Change-Id: $CHANGE_ID"
   ```

   git has no identity in this environment: commit as the author the ticket names, or as `$DSH_SUPERAGENT_GERRIT_USER` with `$DSH_SUPERAGENT_GERRIT_EMAIL`. Set them on the command (`git -c user.name=... -c user.email=... commit ...`) rather than in the clone's git configuration.

4. Push to the review ref, not to a branch:

   ```sh
   git push --push-option="topic=agent/$DSH_SUPERAGENT_NAME" origin "agent/$DSH_SUPERAGENT_NAME:$DSH_SUPERAGENT_GERRIT_PUSH_REF"
   ```

   The push output names the change: a `remote:` line carries `http://<host>/#/c/<project>/+/<number>`. Read that number; it is the change's identity.

Immediately after the push, call `orchestrator_report` with `state: progress` and `change_number` — the number the push printed — so the change is bound to this ticket. Do not wait for a review to report it. Report `ready` only once the change is self-reviewed and the relevant checks have passed.

## Changing a change after a review

A later patch set of the same change **amends** the commit; it never adds a second commit. Gerrit refuses a push that carries one `Change-Id` in two commits, and a second commit would become a change of its own.

```sh
git commit --amend -m "Fix the login redirect" \
  -m "Issue: $DSH_SUPERAGENT_REDMINE_ISSUE_ID" \
  -m "Change-Id: $CHANGE_ID"
git push --push-option="topic=agent/$DSH_SUPERAGENT_NAME" origin "agent/$DSH_SUPERAGENT_NAME:$DSH_SUPERAGENT_GERRIT_PUSH_REF"
```

Keep the same `Change-Id` for every patch set of a change; the number of the change does not change. Read it back with `git log -1 --format=%B`.

## Answering reviewers

The host delivers the review comments and the review notes on the agent's changes to the bound worker. Read each one, decide whether it asks for a change, and act on it. When a comment needs an answer, push a new patch set that addresses it and say what you did in the commit message; the host can post a reply on the change itself, so do not write to the review server by hand.

Record what you did in `orchestrator_report`. A review comment that asks for something beyond the ticket's scope is handed back with `orchestrator_trigger_handback` and a one-sentence reason, unacknowledged; a comment you answered needs no separate message.
