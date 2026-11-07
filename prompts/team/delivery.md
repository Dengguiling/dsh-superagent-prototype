This section describes a patch submitted for review on Gerrit. The change is submitted by pushing it to refs/for/<branch>, reviewers answer on the change itself, and a person submits it: the agent never submits a change for merge.
A change on Gerrit carries a Change-Id trailer and names its task with an Issue: trailer, and the agent reports its change number so the ticket and the change are bound.

For every ticket that changes UI, the change message must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI change is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
A person submits the change: the agent never merges or submits it, and never approves on a reviewer's behalf.
Report ready without waiting for approvals; say in your report that a person submits the change.
Reviewers are recorded on the change itself, so do not add trailers for them; the commit message names the task, not the reviewers.
Never push an empty commit to credit a reviewer.
Do not credit bots, the accounts these instructions name as review bots, the agent account, or the person these instructions name as commit author, who is already the author of every commit.
Record the reviewers you answered in orchestrator_report, so a later worker does not answer them again.
If a person is working on the same problem and their branch contains this ticket's code (commits from the ticket branch, or its changes carried over), do not submit a second change for the same work: report what you found in orchestrator_report and stop.
Work that is only related, or does not contain the ticket's code, is not a reason to stop.
