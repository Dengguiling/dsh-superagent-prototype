# Audit — Superagent panel: configuration & cross-cutting surfaces

Scope of this audit: the Settings page shell and its left nav (`src/client/settings.tsx`,
`src/client/settings-kit.tsx`), the Source status/setup surface (`src/client/source.tsx`), the
prompt editor (`src/client/prompts.tsx`, `src/client/prompt-config.ts`), the Deployment page
(`src/client/deployment.tsx`), the panel data layer (`src/client/provider.tsx`), the routing model
(`src/client/route.ts`), the local UI primitive kit (`src/client/controls.tsx`), the string
dictionary (`src/client/locales.ts`), the header search and glossary (`src/client/app.tsx`), plus
`src/client/client.css` (read-only) as the visual substrate.

Design references used as the yardstick: `docs/005-panel.md` (Settings groups, "Principles"
§67–75) and `docs/004-prompts.md` (how prompt editing is supposed to work).

Every claim below is anchored to a file and line. Line numbers refer to the working tree at the
time of the audit.

---

## 1. Surface inventory

### 1.1 Routes

The panel has one top-level tab bar (`route.ts:7`, rendered at `app.tsx:166–167`) and, inside the
Settings tab, a second level of groups (`route.ts:9`). The second level is *not* a URL — the whole
route model is persisted to `sessionStorage` (`route.ts:57–75`).

| Surface | Route / model | Purpose | Primary action | Fields (editable controls) |
| --- | --- | --- | --- | --- |
| Overview | `{page:'overview'}` (`route.ts:13`) | Live pipeline dashboard, Tickets needing action, system problems | Open a Ticket / fix a problem | 0 |
| Workbench | `{page:'pms'}` (`route.ts:14`) | Operator task inbox (Redmine issues) + conversation | Open a task, archive, reply | 0 (1 composer) |
| Source (status) | `{page:'source'}` (`route.ts:13`) | Source health, filtered Triggers, dropped replies | Open Source settings | 0 |
| Trigger | `{page:'trigger'}` (`route.ts:15–16`) | Threads, Triggers, Decisions, Subscriptions | — | 0 |
| Eval (status) | `{page:'eval'}` (`route.ts:17`) | Decision log | — | 0 |
| Execution (status) | `{page:'execution'}` (`route.ts:18–19`) | Executor state, pause, Ticket list | Pause / resume | 1 (pause switch) |
| **Settings › Sources** | `{page:'settings',query:{group:'source'}}` (`settings.tsx:19`) | One card per Source: endpoints, credentials, receive switches, advanced polling, verified facts | **Save, per card (3 bars)** | **29** (26 spec fields + 3 enable switches) |
| **Settings › Eval** | `group:'eval'` (`settings.tsx:20`) | Policy version + rules; per-Source policy (allowed list, sync, admission table); Eval settings (accept mode, timeout, assessor model) | **Save ×2 (separate bars)** | **~28 fixed** + 3 per rule + 3 per chat row |
| **Settings › Execution** | `group:'execution'` (`settings.tsx:21`) | Executor model, concurrency, directory root, prepare command, blocked commands | **Save ×1** | **7** |
| **Settings › Prompts** | `group:'prompts'` (`settings.tsx:22`) | 3 team sections, 16 built-in parts, N skills; full composed prompt + diff; version history | **Save ×1** | **19 text areas** (3 + 16) + N skills |
| **Settings › Deployment** | `group:'deployment'` (`settings.tsx:23`) | Startup problem, state dir, machine limits | **Save ×1 (only when writable)** | **3** numeric + 1 read-only |
| Header search | *no route* (`app.tsx:127–131`) | Find Triggers / Threads / Tickets by text, id or link | Press **Enter** | 1 input |
| Glossary | *no route* (`app.tsx:28–56`, opened at `app.tsx:132`) | Bilingual term table + state legend | — | 0 (28 terms, 5 groups, 5 legend entries, 5 value groups) |

Field counts are derived from the `FieldSpec[]` of each source kind (`src/sources/feishu.ts:37`,
`src/sources/redmine.ts:34`, `src/sources/gerrit.ts:34`), the `PART_KEYS` list of 16 built-in
prompt parts (`src/app/prompts.ts:26–28`) and the three `TEAM_SECTIONS` (`src/app/prompts.ts:14`).

### 1.2 Settings groups as the code builds them

`settings.tsx:26–37` renders a two-column grid: a 140 px sticky `<nav>` of five group buttons
(`settings.tsx:27–32`) and a body whose `<h2>` repeats the group name (`settings.tsx:34`).
The nav has two visual buckets, distinguished only by a 10 px gap
(`client.css:370`): stage groups (`source`, `eval`, `execution` — `settings.tsx:12`) and everything
else (`prompts`, `deployment`).

### 1.3 The kit (`controls.tsx`)

13 exported primitives: `Icon`, `Button`, `Tag`, `Pill`, `SegmentedTabs`, `SegmentedControl`,
`Input`, `Switch`, `StateDot`, `Dot`, `DisclosureRow`, `Modal`, `InfoTip` (plus the exported types
`IconName`, `TagTone`, `DotState`). The file's own header says it "Mirrors DSH ui-primitives markup
and keyboard behavior without coupling to its internal package API" (`controls.tsx:1–4`).

---

## 2. Findings

### Information architecture

**F-01 — Three of the five Settings groups are named identically to three of the seven top-level tabs. — High**
- **Where**: `locales.ts:522–526` (`settingsGroup.source/eval/execution/prompts/deployment`) vs
  `locales.ts:114–119` (`tab.pms/overview/source/trigger/eval/execution`); rendered side by side at
  `settings.tsx:27–32` and `app.tsx:166–167`.
- **What happens**: `settingsGroup.eval` = `['评估','Eval']` = `tab.eval`. `settingsGroup.execution`
  = `['执行','Execution']` = `tab.execution`. `settingsGroup.source` = `['来源','Sources']` shares
  the exact Chinese string `来源` with `tab.source` = `['来源','Source']` (English differs only by a
  plural). The status tab and the configuration group that configures it carry the same name.
- **Why it hurts**: the operator who clicks **Eval** expecting the Decision log lands on a page
  about admission rules; the one who is on the Eval settings page cannot tell from the label
  whether they are looking at decisions or at policy. It also breaks the panel's own principle
  "One place per concept" (`docs/005-panel.md:71`).
- **Severity**: High
- **Suggested fix**: rename the settings groups to name *what they configure* — "Source
  configuration", "Policy & admission", "Executor" — so no settings label collides with a tab label.

**F-02 — The Settings left nav is a flat list of five unlabelled groups; the grouping is a 10 px gap. — Medium**
- **Where**: `settings.tsx:27–32`; the only separation is
  `.dt-settings-link[data-stage] + .dt-settings-link:not([data-stage]) { margin-top: 10px }`
  (`client.css:370`).
- **What happens**: "Sources / Eval / Execution" (stage concepts) and "Prompts / Deployment"
  (whole-deployment concepts) appear as one run of five links with no heading, no icon and no
  description. There is no per-group summary (no count of unsaved changes, no "2 problems here").
- **Why it hurts**: five links in a column with one invisible break give the operator no model of
  the configuration space; the flat list also invites the reading that "Execution" is a peer of
  "Prompts" when one configures a stage and the other configures the agent's words.
- **Severity**: Medium
- **Suggested fix**: add two labelled nav sections ("Stage configuration" / "Agent & deployment")
  and put a status dot on any group that holds an unsaved draft.

**F-03 — The group name is printed twice on the same screen. — Low**
- **Where**: nav item `settings.tsx:31` and page heading `settings.tsx:34`.
- **What happens**: the body opens with `<h2 className="dt-settings-title">来源 / Sources</h2>`
  immediately under a nav whose selected item already reads "来源 / Sources".
- **Why it hurts**: duplicated chrome eats vertical space in a page whose real content (forms) is
  already long, and it makes the nav look like a tab bar that failed to switch.
- **Severity**: Low
- **Suggested fix**: drop the redundant `<h2>` and let the nav selection carry the group name, or
  replace the `<h2>` with the group's one-line purpose.

**F-04 — Nothing in Settings is URL-addressable; a link to a setting cannot be shared. — Medium**
- **Where**: `route.ts:57–75` (`ROUTE_KEY`, `initialLocation`, `remember` on `sessionStorage`),
  `app.tsx:175–176`.
- **What happens**: the settings group (`route.query.group`), the focused source
  (`route.query.source`, `settings.tsx:19` / `source.tsx:116–119`) and the highlighted policy
  version (`route.query.version`, `eval.tsx:221`) live only in session storage. The panel is a DSH
  main-panel slot, so the browser URL never changes.
- **Why it hurts**: an operator cannot paste "the Redmine source settings" into a ticket, a chat
  message or a handover note; a support conversation has to say "Settings › Sources › Redmine".
  It also means the browser Back button leaves the panel instead of the previous group.
- **Severity**: Medium
- **Suggested fix**: encode the settings route in the URL hash (`#/settings/source/redmine`) so
  every settings screen has a shareable address.

**F-05 — The Deployment group has no save history, contradicting the panel's own documentation. — Low**
- **Where**: `deployment.tsx:61–86` renders no `ConfigHistory`; `ConfigHistory` is mounted only at
  `source.tsx:66`, `eval.tsx:225`, `execution.tsx:125`. `docs/005-panel.md:25` states "Each group
  includes its save history".
- **What happens**: an operator who changes a machine limit cannot see when it was changed, by whom,
  or what it was before.
- **Why it hurts**: the Deployment limits are host-level configuration shared with the rest of the
  machine; without history the operator cannot tell whether a limit is theirs or a leftover.
- **Severity**: Low
- **Suggested fix**: add a `ConfigHistory` disclosure to the Deployment group, or correct the doc.

**F-06 — The Deployment page renders differently in the two places it lives. — Medium**
- **Where**: `settings.tsx:23` renders `<DeploymentPage setup={state.setup} form={deploymentForm} />`
  (no `accounts` prop); `deployment.tsx:94` renders `<DeploymentPage … accounts />`.
- **What happens**: the "Source accounts" section (`deployment.tsx:67–71`, `deploymentDerived` /
  `deploymentDerivedHint` / `deploymentAccountsWhere`) appears only in the DSH Plugin Manager
  variant. In the panel's own Settings › Deployment the operator sees just the state directory and
  the three limits — while the copy at `locales.ts:629` still promises "Accounts are changed in the
  Source settings of the dsh-superagent panel", with no account list anywhere on the page.
- **Why it hurts**: the panel's primary Deployment page is missing the one thing that tells the
  operator *which accounts the agent acts as* — and the documentation says the Plugin Manager
  "exposes the same page" (`docs/005-panel.md:59`), which is not true.
- **Severity**: Medium
- **Suggested fix**: render the account summary in both variants (or in neither) and make the copy
  match.

**F-07 — The panel's Deployment page and the Plugin Manager's Deployment page are two independent drafts over one host configuration, and the panel's draft is not persisted at all. — High**
- **Where**: both entry points render the same `DeploymentPage` component but as separate React
  trees bound to the same host `ConfigForm`: `settings.tsx:23` (panel Settings › Deployment) and
  `deployment.tsx:90–97` (`PluginPage`, mounted at `src/client/index.tsx:56–57` from the
  `plugins.row.config` slot). The form object is shared (`src/client/index.tsx:44` —
  `ctx.get('configForms')?.get(ENTRY)`), but each tree creates its own `useDraft`
  (`deployment.tsx:38–46`) — and that call **passes no `key`**, unlike every other settings draft
  (`settings-kit.tsx:37` uses `dsh-superagent/draft/…`, `prompts.tsx:32` uses
  `dsh-superagent/prompts/…`).
- **What happens**: three consequences. (a) Because `key` is undefined, `draft.tsx:140` never
  rehydrates and `draft.tsx:145` never writes — **the Deployment draft is the only settings draft
  in the panel that is lost on reload**. (b) The two trees hold two unrelated drafts over one
  configuration: a limit typed in the panel is invisible in the Plugin Manager, and vice versa.
  (c) When the operator returns to the panel after the Plugin Manager saved, `useDraft`'s
  `revisionArrived` (`draft.tsx:95–106`) merges the two drafts key by key through `merge3`; the
  local edit wins and the operator is told only the generic
  "Settings changed elsewhere, including items you changed too" (`locales.ts:518`) — the prompt
  editor has a field-level variant (`promptConflictParts`, `locales.ts:612`) that the Deployment
  page does not use, so the operator is not told *which* limit collided.
- **Why it hurts**: the Deployment limits are host-level and shared with the whole machine, yet
  they are the one place where two screens of the same product can edit the same value with no
  shared draft, no persistence, and a non-specific conflict message.
- **Severity**: High
- **Suggested fix**: give the Deployment draft a `key` like every other block, render the
  field-level conflict message, and make the Plugin Manager variant embed the panel's Deployment
  page rather than a second copy of it.

### Form & input design

**F-08 — `Field` emits a `<label for>` that points at nothing for two of its four control kinds. — High**
- **Where**: `settings-kit.tsx:56–63` — `Field` renders `<label htmlFor={id}>` and
  `cloneElement(children, { id })`; `settings-kit.tsx:249–252` (select → `SegmentedControl`) and
  `settings-kit.tsx:64–70` (switch → `SwitchRow`/`Switch`). `SegmentedControl`
  (`controls.tsx:113–125`) and `Switch` (`controls.tsx:132–138`) destructure a fixed prop list and
  have no `...rest`, so the injected `id` is silently dropped.
- **What happens**: for the accept-mode selector and every switch row, the DOM contains
  `<label for=":r7:">` pointing to an id that exists nowhere. Clicking the visible text does
  nothing, and the visible text is not programmatically associated with the control.
- **Why it hurts**: the visible label is the only description of a setting; an operator who clicks
  the words "接单模式 / Accept mode" gets no response and no feedback about why.
- **Severity**: High
- **Suggested fix**: give `SegmentedControl` and `Switch` an `id`/`aria-labelledby` prop (or render
  `Field` as a `<div>` + `aria-labelledby` instead of `<label for>` when the child cannot take an id).

**F-09 — The same concept — "enable this" — is rendered three different ways. — Medium**
- **Where**: `settings-kit.tsx:64–70` (`SwitchRow`: visible text + switch, in a row);
  `source.tsx:43–44` (enable switch with **no visible text at all**, only
  `aria-label={t('sourceEnable', …)}`); `eval.tsx:67–68` (rule enable switch, label only in
  `aria-label`).
- **What happens**: in the Source card header the enable toggle is an unlabelled pill next to the
  Source name; in the Eval rule list it is a pill next to the rule name; in a `switch` spec field it
  is a labelled row with the text on the left.
- **Why it hurts**: an unlabelled switch next to a title reads as "this card is on/off", not "this
  Source receives work"; the operator has to hover or use a screen reader to learn what it does.
  The three treatments also make the settings pages look like three different products.
- **Severity**: Medium
- **Suggested fix**: pick one pattern — a labelled row with the switch on the right — and use it for
  the Source card, the rule list and every `switch` field.

**F-10 — Validation failures report raw dotted API paths and throw away the server's reason. — Medium**
- **Where**: `draft.tsx:159` — `const fields = failure instanceof ApiError ? failure.issues.map(issue => issue.path) : []`;
  the server builds those paths at `src/app/http.ts:90–92`
  (`path: issue.path.join('.')`, `message: issue.message`).
- **What happens**: a rejected save renders `invalidSettings`
  (`locales.ts:521` — "这些字段无效：{fields}") filled with paths such as
  `sources.redmine.config.apiKey` or `policy.rules.0.instruction`. The per-issue `message`
  ("Required", "Expected string, received number") is delivered by the server and never read.
- **Why it hurts**: the operator is told a field is invalid in a path they have never seen, and is
  not told *why*, so they cannot tell a missing value from a malformed one — and they cannot find
  the offending control, because the path does not correspond to any visible label.
- **Severity**: Medium
- **Suggested fix**: map the failing path back to the field's localized label (the same
  `FieldSpec.label` the form renders) and show the server's message next to it.

**F-11 — Save errors are clipped to three lines with no way to read the rest. — Medium**
- **Where**: `draft.tsx:196` — `<p className="dt-error dt-clamp" role="alert">{line.error}</p>`;
  `.dt-clamp { -webkit-line-clamp: 3 }` (`client.css:108`).
- **What happens**: any error longer than three lines — an `invalidSettings` message with several
  field paths, a server error with a stack-ish detail — is cut off with no ellipsis control, no
  title attribute and no expand affordance.
- **Why it hurts**: the operator sees a truncated red line at the bottom of a card and cannot tell
  what went wrong; the full text is only in the DOM.
- **Severity**: Medium
- **Suggested fix**: drop `dt-clamp` from the save bar (it is the one place the message must be
  complete), or add an expand/collapse for long errors.

**F-12 — The rows editor has no empty state. — Low**
- **Where**: `settings-kit.tsx:216–238` — when `rows.length === 0` the `<ul className="dt-rows">`
  is empty and only the "Add row" button (`addRow`, `locales.ts` group) is shown.
- **What happens**: an empty allowed-list or chat list renders as a bare button in a card, with no
  indication of what the list is for or what will appear there.
- **Why it hurts**: the operator cannot tell an empty list from a list that failed to load, and the
  label above it is only a name, not a count of what is expected.
- **Severity**: Low
- **Suggested fix**: render a one-line hint when the list is empty ("No accounts yet — add one to
  let them originate work").

**F-13 — Units live in labels only, and three incompatible units share one section. — Low**
- **Where**: `settings-kit.tsx:253–256` (`number` → `<Input type="number">` with no unit adornment);
  `deployment.tsx:79–83` puts "characters", "Thread pages" and "milliseconds" in one "Limits"
  section; the seconds label is `轮询间隔 / 秒` (`src/sources/redmine.ts:52`).
- **What happens**: the value `30000` in "一次上下文读取的时限 / 毫秒" has to be converted by the
  operator; the neighbouring `LIMITS.admissionContextTimeoutMs.max` is 90 000, but the operator
  cannot see either bound — `min`/`max` are HTML attributes only.
- **Why it hurts**: guessing a millisecond value from a bare number is a common source of
  misconfiguration, and the accepted range is invisible.
- **Severity**: Low
- **Suggested fix**: render the unit as a suffix inside the control and show the allowed range as
  the field's hint.

### Interaction & state feedback (save / dirty / validation / undo)

**F-14 — There is no undo anywhere; "Discard changes" is the only reversal and it is not confirmed. — High**
- **Where**: `grep -rn "undo" src/client/` returns nothing. The only reversal is the Save bar's
  Discard button (`draft.tsx:198`, label `discard` = "放弃修改 / Discard changes",
  `locales.ts:517`), wired to `draft.discard` at `source.tsx:57`, `eval.tsx:190`, `eval.tsx:217`,
  `execution.tsx:123`, `deployment.tsx:85`, and to `draft.discard()` at `prompts.tsx:66`.
  `docs/005-panel.md:74` states "Destructive actions require confirmation."
- **What happens**: one click on Discard throws away every edit in that block — the whole Redmine
  card, the whole Policy, the whole prompt configuration — with no confirmation and no undo. In the
  Sources group each card has its own draft, but in the Execution group one draft covers both the
  model/capacity block and the environment block (`execution.tsx:80–83`), so one Discard loses both.
- **Why it hurts**: prompt text and Policy rules are expensive to rewrite. An operator who
  mis-clicks Discard has to reconstruct the work from memory or from the session-storage draft,
  which the Discard itself deletes (`draft.tsx:146`).
- **Severity**: High
- **Suggested fix**: confirm Discard with a modal naming what will be lost, and add a per-field or
  per-section undo stack so a single mistyped value can be reversed.

**F-15 — A pending draft is invisible outside the block that owns it. — High**
- **Where**: the nav (`settings.tsx:27–32`) renders no dirty marker; the only cue is the
  block's own Save bar, which is `position: sticky; bottom: 0` inside that card
  (`client.css:219–221`) and is only rendered while `dirty || busy || error`
  (`draft.tsx:182`).
- **What happens**: the operator edits the Redmine API key, clicks **Prompts** in the left nav, and
  the pending edit disappears from view. The draft survives (it is rehydrated from session storage
  by `draft.tsx:139–141`), but nothing on screen says so. Returning to Sources shows the bar again
  with "Unsaved · draft restored" (`draft.tsx:125`, `locales.ts:513`) — but only if the operator
  remembers to go back.
- **Why it hurts**: an operator can leave the panel, or close the tab (there is no `beforeunload`
  guard — `grep -rn "beforeunload" src/` returns nothing), with a half-finished configuration change
  and no signal that it existed.
- **Severity**: High
- **Suggested fix**: put a dirty dot on the owning nav item and a count in the tab bar, and warn on
  tab close while any draft is pending.

**F-16 — A failed save is reported only inside the block's own save bar; only successes raise a toast. — Medium**
- **Where**: `useBlockDraft` notifies only on success (`settings-kit.tsx:39` —
  `notify(t(result.restarting ? 'savedRestarting' : 'saved'))`); the failure path is
  `dispatch({type:'refused', notice})` inside `draft.tsx:149–164`, which renders into the block's
  save bar only.
- **What happens**: in the Sources group there are three cards and therefore three independent save
  bars. If the Gerrit card is scrolled out of view and its save fails, the operator sees nothing —
  no toast, no badge, no error at the top of the page. The only feedback is a red line at the
  bottom of a card that may be off-screen.
- **Why it hurts**: the operator believes the configuration is saved. In a group of three source
  cards this is a realistic failure mode.
- **Severity**: Medium
- **Suggested fix**: raise a toast for failed saves too, and mark the offending card.

**F-17 — The save bar has no "Saving…" state; during a save it claims the draft is still unsaved. — Medium**
- **Where**: `draft.tsx:114–126` (`saveBarText`). For `phase === 'saving'` the function falls through
  to `words.editing ?? t('draftKept')` — "未保存 · 草稿已保留 / Unsaved · draft kept"
  (`locales.ts:514`). The Save button gets `disabled={!dirty || busy}` (`draft.tsx:199`) but no
  spinner and no `dt-btn-busy` class (that class exists and is used only by the labels-refresh
  button, `settings-kit.tsx:220–222`).
- **What happens**: the operator clicks Save and the bar immediately reads "Unsaved · draft kept",
  with both buttons greyed out. Only after the server answers does it flip to "已保存 / Saved".
- **Why it hurts**: for a slow save (a source save restarts the agent) the bar appears frozen and
  says the opposite of what is happening.
- **Severity**: Medium
- **Suggested fix**: give the bar an explicit `saving` phase with its own wording and a busy
  indicator on the Save button.

**F-18 — The "saving will interrupt running work" warning replaces the dirty-state text, and only appears when work is running. — Medium**
- **Where**: `source.tsx:56` — `<SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', {count: running}) : undefined} …/>`;
  `draft.tsx:196–197` renders `status ?? line.status`, so the warning **replaces** the draft text.
- **What happens**: two things go wrong at once. (a) When assignments are running, the operator
  loses the "Unsaved · draft kept" cue entirely — the bar shows only the restart warning.
  (b) When nothing is running (`running === 0`), no warning is shown at all, even though saving the
  account fields still restarts `dsh-superagent` — a fact the field hints mention
  (`src/sources/redmine.ts:37`, `src/sources/gerrit.ts:37`, `src/sources/feishu.ts:39`) but that no
  button states.
- **Why it hurts**: the operator either loses the dirty cue or gets no warning at all, depending on
  coincidental load. "Saving restarts the agent" should be a property of the control, not of the
  current workload.
- **Severity**: Medium
- **Suggested fix**: always state that the save restarts the agent on the affected fields, and show
  the interruption count as an additional, separate line.

**F-19 — No keyboard way to save, and no guard against losing the tab. — Low**
- **Where**: no `ctrlKey`/`metaKey` handler exists anywhere in `src/client/`; no `beforeunload`
  listener exists. `prompts.tsx:57–67` does not use a `<form>` at all, so pressing Enter in the
  prompt editor cannot save — while in the Source/Eval/Execution forms Enter inside a text input
  submits and saves (`source.tsx:34`, `eval.tsx:158`, `execution.tsx:93`).
- **What happens**: "Enter saves" in some settings pages and not in Prompts; Cmd/Ctrl+S never
  saves; closing the tab with a pending draft loses it silently.
- **Why it hurts**: inconsistent submit behaviour across one tab, and no safety net for a long
  prompt edit.
- **Severity**: Low
- **Suggested fix**: wrap the Prompts page in a `<form>` too, add a Cmd/Ctrl+S handler in the panel,
  and add a `beforeunload` guard while any draft is dirty.

**F-20 — The prompt "Compare with" control keeps its initial choice after the draft becomes dirty. — Medium**
- **Where**: `prompts.tsx:185` — `const [compare, setCompare] = useState<'saved'|'default'>(dirty ? 'saved' : 'default')`;
  `prompts.tsx:196` — `const shown = dirty ? compare : 'default'`.
- **What happens**: `dirty` is read once at mount. If the operator opens the Full prompt tab while
  the draft is clean, `compare` is `'default'`; they then go back to Edit, type something, and
  return to Full prompt — `dirty` is now true but `compare` is still `'default'`, so the view
  compares against the *defaults* even though the useful comparison at that moment is against the
  *saved* version.
- **Why it hurts**: the operator does not see their own change against the last saved state, which
  is the comparison that answers "what am I about to change?".
- **Severity**: Medium
- **Suggested fix**: derive the default comparison from the current dirty state rather than
  capturing it at mount.

**F-21 — Two different "changed" markers with no legend. — Medium**
- **Where**: `prompts.tsx:92` — `{config[section] !== view.defaults[section] && <span className="dt-changed-tag">{t('promptChanged')}</span>}`
  ("已改 / Changed", meaning *differs from the built-in default*); `prompts.tsx:79` —
  `const unsaved = (section: string) => changed.includes(section) && <span className="dt-changed-dot" aria-label={t('unsaved')} />`
  (meaning *differs from the saved version*). The legend in the glossary lists only the five dot
  states (`app.tsx:47–49`).
- **What happens**: a section that the team customized long ago shows a "已改 / Changed" chip; a
  section you are editing right now shows a small blue dot. Nothing in the UI, the glossary or the
  tooltips explains the difference between the two, and both appear side by side in the same nav
  column.
- **Why it hurts**: an operator cannot tell "this differs from the shipped default" (a durable
  fact) from "you have an unsaved edit" (a transient fact) — the second is the one that must not
  be missed.
- **Severity**: Medium
- **Suggested fix**: rename the first marker to "Customized" / "自定义", keep the dot as the only
  unsaved cue, and add both to the glossary legend.

**F-22 — The full-prompt preview is a server composition, but it is presented as a local view. — Low**
- **Where**: `prompts.tsx:189–195` — the preview is fetched with `POST prompts/preview` and the
  component shows `<LoadState loading error={error} />` while it is in flight.
- **What happens**: the Full prompt tab replaces the editor with a spinner on every open, and the
  composed text is the server's assembly, not a local render of the draft.
- **Why it hurts**: the spinner reads as a page load; the operator cannot tell that the text shown
  is a server-composed artifact (which includes the generated Policy section) rather than what
  their textarea contains.
- **Severity**: Low
- **Suggested fix**: label the view ("Composed by the server from your draft") and keep the
  previous text visible while the new preview loads.

### Layout & responsive

**F-23 — At narrow widths the Settings nav becomes an unlabelled row of five links and the prompt nav moves above the editor. — Medium**
- **Where**: `client.css:381–386` — `.dt-settings { grid-template-columns: 1fr }` and
  `.dt-settings-nav { position: static; flex-direction: row; flex-wrap: wrap }`;
  `client.css:250` — `.dt-grid3, .dt-prompt { grid-template-columns: 1fr }`.
- **What happens**: the 140 px column of five group names becomes a wrapping row of text links
  whose only active-state signal is a background tint (`client.css:369`). The prompt editor's
  200 px section column becomes a full-width stack *above* the textarea, so on a phone the operator
  scrolls past 19+ section links to reach the editor they just chose.
- **Why it hurts**: the two most navigation-heavy surfaces become the hardest to use at exactly the
  size where the panel is a sidebar.
- **Severity**: Medium
- **Suggested fix**: keep the settings nav as a horizontal tab strip with an active underline, and
  collapse the prompt section list into a `<select>` or a single-line picker on narrow screens.

**F-24 — The prompt editor's textarea has a fixed 360 px minimum and is the only scroll target. — Low**
- **Where**: `client.css:185` — `.dt-editor { min-height: 360px }`; `client.css:147` —
  `.dt-textarea { resize: vertical }`.
- **What happens**: on a short viewport the textarea plus the sticky save bar exceeds the panel
  height; the operator must scroll the panel, not the textarea, to reach the Save button (which is
  sticky at the bottom of the *card*, `client.css:219`).
- **Why it hurts**: on a laptop with the panel docked, the Save button and the text being edited
  are often not visible at the same time.
- **Severity**: Low
- **Suggested fix**: make the editor fill the remaining height (`min-height: 0; flex: 1`) inside a
  flex column so the save bar stays adjacent to it.

**F-25 — Every source card has its own sticky save bar, so a bar can overlay the next card's fields. — Low**
- **Where**: `source.tsx:34` — each `SourceCard` is its own `<form>` with a `<SaveBar>` at
  `source.tsx:56`; `client.css:219–221` — `.dt-savebar { position: sticky; bottom: 0 }` and
  `.dt-card > .dt-savebar { margin: 0 -16px -16px }`.
- **What happens**: scrolling from the Redmine card to the Gerrit card keeps the Redmine bar
  pinned over the Gerrit card until the Redmine card leaves the viewport.
- **Why it hurts**: two save bars can be on screen at once, and the top one belongs to a card the
  operator is no longer looking at.
- **Severity**: Low
- **Suggested fix**: use one save bar per settings group with a "Save all" that names the affected
  blocks, or keep the bars non-sticky and float a single group-level bar.

### Copy & terminology

**F-26 — The same Redmine issue is called "事务" in one place and "任务" in another. — High**
- **Where**: `locales.ts:107` (`searchNone`: "Redmine 事务链接"), `locales.ts:182`
  (`pmsDeleteMessage`: "不删除 Redmine 事务"), `src/sources/redmine.ts:31` (Source description:
  "接收事务与事务下的讨论") — versus `locales.ts:154` (`pmsTitle` = "任务工作台 / Task workbench"),
  `locales.ts:130` (`pmsSource` = "任务系统 / the task system"), `locales.ts:135`
  (`pmsFlow.tasks` = "任务 / Tasks").
- **What happens**: the Workbench lists Redmine issues as **任务** and the same rows are called
  **事务** in the Source settings, the search hint and the delete confirmation. The English does
  not have this problem: it says "the task system" for the system and "issue" for the row, while
  the Chinese uses 任务系统 for the system, 事务 for a row in some strings and 任务 for a row in
  others.
- **Why it hurts**: a Chinese operator reading "任务" in the Workbench and "事务" in the delete
  confirmation cannot tell whether they are two different kinds of object. The panel's own
  principle is "Precise definitions … a label says whom a row waits for and what it needs"
  (`docs/005-panel.md:70`); two names for one object breaks that.
- **Severity**: High
- **Suggested fix**: pick one word for a Redmine issue (建议 **任务**, since the Workbench is the
  primary surface) and use it in the Source description, the search hint and the delete message;
  reserve 事务 for nothing.

**F-27 — "Source" and "Sources" are the same word in Chinese, on two different screens. — Medium**
- **Where**: `locales.ts:116` (`tab.source` = "来源 / Source") vs `locales.ts:522`
  (`settingsGroup.source` = "来源 / Sources"); the settings nav at `settings.tsx:31` and the top
  tab bar at `app.tsx:167` sit 40 px apart on the same screen.
- **What happens**: the Chinese UI offers "来源" as both a status tab and a settings group; the
  English disambiguates only by a plural, which reads as "several sources" rather than
  "configuration of the sources".
- **Why it hurts**: the operator cannot tell from the label which "来源" they are looking at, and
  the tab that *is* the Source status page is the one that carries a Settings gear
  (`widgets.tsx:127–128`) whose label is just "设置 / Settings" — it does not say *which* settings
  it opens.
- **Severity**: Medium
- **Suggested fix**: use "来源状态 / Source status" for the tab and "来源配置 / Source configuration"
  for the group; label the gear "来源配置".

**F-28 — The glossary is the only bilingual aid and nothing in the UI points to it. — Medium**
- **Where**: the only entry point is the header "?" button (`app.tsx:132–133`); `grep` shows no
  other reference to the glossary anywhere in `src/client/`.
- **What happens**: to learn what "准入 / Gate" or "派工 / Assignment" means, the operator must
  find the "?" in the header, open a modal, and scroll a 28-row table. The glossary's own group
  headings reuse the top-level tab labels (`app.tsx:32` → `t('tab.${group}')` for `source`,
  `trigger`, `eval`, `execution`), which reinforces the F-01 label collision rather than
  disambiguating it.
- **Why it hurts**: the glossary exists for exactly the operator who cannot infer the English term
  from the Chinese label — the one most likely to be reading a Chinese UI and an English
  `docs/006-deployment.md`. A modal they must go and find is a poor answer.
- **Severity**: Medium
- **Suggested fix**: make glossary terms inline-linkable from the places they appear (the Policy
  rows, the stage labels), and give the glossary its own search box.

**F-29 — The glossary shows the "Meaning" column in the UI language only. — Medium**
- **Where**: `app.tsx:43` — `<td>{own[`meaning.${key}`]}</td>`; the table's columns are
  [own-language term, other-language term, meaning] (`app.tsx:37–39`).
- **What happens**: a Chinese-reading operator sees 中文 term | English term | Chinese meaning, but
  never the English meaning — the thing they would need to match a sentence in an English doc or a
  log line. The English-reading operator has the mirror-image gap.
- **Why it hurts**: the glossary's stated purpose (`locales.ts:688` — "The interface shows one
  language; documents, code and tools use the English terms") is to bridge the two languages;
  bridging only the term and not the meaning leaves the operator to translate the meaning anyway.
- **Severity**: Medium
- **Suggested fix**: show both meanings, or make the meaning column a two-line cell with the
  secondary language collapsed behind a toggle.

**F-30 — Search counts report what was shown, not what matched. — Low**
- **Where**: `app.tsx:72` — `const counts = { tickets: result.tickets.length, threads: …,
  items: result.items.length }`; `app.tsx:76–77` renders `searchFound` / `searchFoundCapped` with
  those counts. The server slices tickets to 10 (`src/app/views/threads.ts:76`) and Triggers to 20
  (`:87`).
- **What happens**: the header reads "找到 3 个工单、1 个线程、5 条触发 / Found 3 Tickets, 1
  Threads and 5 Triggers" — but the server may have found 30 tickets and returned 10, and the
  client cannot tell. The "capped" wording (`locales.ts:112`) fires only when the *Trigger* count
  reaches 20, so a 30-match ticket search reports a confident "3".
- **Why it hurts**: the operator concludes there is nothing else to find, when a Ticket they
  expected is in the truncated tail. This contradicts "Honest state" (`docs/005-panel.md:73`).
- **Severity**: Low
- **Suggested fix**: have the API return the total match count per kind alongside the page, and
  render "showing 10 of 34".

**F-31 — "Restore" means three different things in the Prompts page. — Low**
- **Where**: `prompts.tsx:129` (`promptResetSection` = "恢复此段默认内容 / Restore this section
  default"), `prompts.tsx:281` (`promptRestore` = "将这个版本载入草稿 / Load this version into the
  draft"), `prompts.tsx:287` (`promptDefaults` = "将整套默认内容载入草稿 / Load all defaults into
  the draft").
- **What happens**: three actions in one tab — reset a section, load a historical version, load the
  defaults — are described with near-synonyms ("Restore", "Load"), and the second and third are
  destructive in exactly the same way (they replace the whole draft) but neither is confirmed.
- **Why it hurts**: an operator scanning for a "Restore" button can pick the wrong one and
  silently replace their draft.
- **Severity**: Low
- **Suggested fix**: one verb per action — "Reset section", "Load version N", "Load defaults" —
  and confirm the two whole-draft replacements.

### Visual system consistency

**F-32 — `controls.tsx` re-implements nine primitives the DSH host already ships. — High**
- **Where**: `controls.tsx:1–4` states the intent ("Mirrors DSH ui-primitives markup and keyboard
  behavior without coupling to its internal package API"). The host package
  `@deepseek-ai/dsh-client-ui-primitives` exports, among others, `Button`, `Pill`, `Input`,
  `Modal`, `Tooltip`, `Toast`, `StateDot`, `DisclosureRow`, `Menu` and a full `ic_ds_*` icon set
  (`lib/types/index.d.ts`, `lib/types/icons/index.d.ts` in the published package; the same package
  is a `devDependency` of the host's own `dsh-client-ui-model-selection`). The plugin's own
  `package.json:63–87` does **not** list it as a peer dependency, and it is not installed in
  `node_modules/@deepseek-ai/`.
- **What happens**: the panel ships its own `Button`, `Input`, `Pill`, `Modal` (with its own focus
  trap, `controls.tsx:171–215`), `InfoTip` tooltip, `Toast` (`provider.tsx:65–71`), `StateDot` and
  a 35-glyph hand-drawn icon set (`controls.tsx:11–47`) — while the host renders the rest of the
  application with its own versions of exactly these.
- **Why it hurts**: the panel's controls cannot inherit host behaviour fixes (focus rings, hover
  states, reduced-motion handling, RTL) and will visibly diverge from the surrounding Harness UI.
  It also means the plugin cannot use host features the primitives already have — the host
  `DisclosureRow` takes `expandable`/`expandOnRowClick`/`previewChevron`, the host `Modal` takes
  `headless`/`contentClassName`, the host `Tooltip` takes `delayMs`/`side`/`maxWidth` — none of
  which the local versions support.
- **Severity**: High
- **Suggested fix**: add `@deepseek-ai/dsh-client-ui-primitives` as a peer dependency and import
  the host's `Button`, `Input`, `Pill`, `Modal`, `Tooltip`, `Toast`, `StateDot`, `DisclosureRow` and
  `icons`, keeping only genuinely panel-specific pieces (the `SegmentedTabs`/`SegmentedControl`
  wrappers, `Dot`, `Tag`) locally.

**F-33 — The kit hard-codes every font size as raw pixels although the host ships a complete type scale. — Medium**
- **Where**: `client.css` writes `font-size: <n>px` in 97 rules; the host theme defines
  `--dsw-font-xxxs-11` … `--dsw-font-xl-24`, each with size, weight, line-height and family
  (`dsh-client-ui-theme/lib/client.js` in the host install). The panel references **none** of them.
- **What happens**: four of the panel's sizes (15, 17, 22 and 28 px) are not in the host's scale at
  all; the rest re-type a size the host already names as a token, as a literal.
- **Why it hurts**: the panel's typography drifts from the surrounding Harness UI and cannot follow
  a host type-scale change — the one token family the host designed to be shared is the one the
  panel bypasses entirely.
- **Severity**: Medium
- **Suggested fix**: map every size to the host token (`--dsw-font-xs-13-font-size` etc.) and
  re-derive the four off-scale sizes from the scale.

**F-34 — The local `Button` has three variants where the host has four, and `StateDot` has five states where the host has four. — Low**
- **Where**: `controls.tsx:54` — `variant?: 'primary' | 'ghost' | 'outline'`; the host's
  `ButtonVariant` is `'primary' | 'ghost' | 'outline' | 'toolbar'`. `controls.tsx:140` —
  `DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'`; the host's `StateDotState` is
  `'done' | 'warning' | 'ongoing' | 'error'`.
- **What happens**: the panel has no `toolbar` variant, so a toolbar-style button in the panel will
  not look like one in the host; and the panel's fifth dot state (`idle`) is a local invention
  rendered as a grey dot (`client.css:299`).
- **Why it hurts**: small divergences accumulate; the `idle` dot in particular has no host
  counterpart, so a legend entry describes a state the host UI cannot produce.
- **Severity**: Low
- **Suggested fix**: adopt the host's variant set and map `idle` to the host's neutral/idle token
  rather than a new semantic.

**F-35 — `question` and `ask` are byte-identical glyphs. — Low**
- **Where**: `controls.tsx:17` and `controls.tsx:42` — both
  `'M12 3a9 9 0 1 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01'`.
- **What happens**: the header's glossary button and the "waiting for a person" Ticket stage use
  the same circle-with-question-mark shape; only the colour separates them.
- **Why it hurts**: an operator who has learned "question mark = needs me" will read the glossary
  button as another alert.
- **Severity**: Low
- **Suggested fix**: use the host icon set (F-32) or give the two meanings distinct glyphs.

**F-36 — `SegmentedTabs` sets an inline grid template that the page stylesheet overrides. — Low**
- **Where**: `controls.tsx:106` — `style={{ gridTemplateColumns: `repeat(${items.length},
  minmax(0, 1fr))` }}`; `client.css:277` — `.dt-tabs { display: grid }` but `client.css:336`
  (`.dt-page .dt-tabs`) and `client.css:14` set `display: flex`.
- **What happens**: inside the page the tab bar is a flex row, so the inline `gridTemplateColumns`
  has no effect; the component's grid sizing only applies where the page override does not reach.
- **Why it hurts**: the component's layout contract differs between call sites, so a change to the
  tab count silently changes the bar's behaviour in one place and not the other.
- **Severity**: Low
- **Suggested fix**: make `SegmentedTabs` layout-neutral (no inline grid template) and let the
  call site's stylesheet decide, or give the page variant its own class.

### Accessibility

**F-37 — Two tab strips use `role="tab"` with no tabpanel, no roving tabindex and no arrow keys. — Medium**
- **Where**: `prompts.tsx:58–59` — `<div className="dt-subtabs" role="tablist">` with
  `<button role="tab" aria-selected=…>`; `eval.tsx:178–183` — the same pattern for the per-Source
  Policy tabs. Compare `controls.tsx:85–112` (`SegmentedTabs`) and `controls.tsx:113–125`
  (`SegmentedControl`), which implement roving `tabIndex` and the Arrow/Home/End handler `walk`
  (`controls.tsx:72–82`).
- **What happens**: in the Prompts page and the Eval page the tab strip is announced as a tab list,
  but there is no `role="tabpanel"`, no `aria-controls`, and Tab moves through every tab instead of
  Arrow keys moving between them.
- **Why it hurts**: screen-reader users get a tab pattern that does not work as promised, and
  keyboard users get a different interaction from the panel's other tab strips.
- **Severity**: Medium
- **Suggested fix**: render both strips with the existing `SegmentedTabs`/`SegmentedControl` kit
  (or add the `walk` handler, roving `tabIndex` and a matching `tabpanel`).

**F-38 — The unsaved dot's label is on a bare `<span>`. — Medium**
- **Where**: `prompts.tsx:79` — `<span className="dt-changed-dot" aria-label={t('unsaved')} />`;
  `client.css:182` — `.dt-changed-dot { width: 6px; height: 6px; … }`.
- **What happens**: `aria-label` on an element with no role and no content is not reliably exposed;
  screen readers announce nothing for the dot.
- **Why it hurts**: the single most important piece of state in the prompt editor — "this section
  has unsaved changes" — is invisible to assistive technology.
- **Severity**: Medium
- **Suggested fix**: give the dot `role="img"` with the label, or render the label as visually
  hidden text.

**F-39 — The whole hint text becomes the accessible name of a 16 px "?" button. — Medium**
- **Where**: `controls.tsx:239` — `<button … className="dt-info" aria-label={text}>`; the text is
  the field hint, e.g. the Redmine API-key hint
  (`src/sources/redmine.ts:39`): "The REST web services key of the agent account in Redmine; it is
  a credential and never reaches the agent environment." The tooltip bubble is a separate
  portaled `<span role="tooltip">` (`controls.tsx:247`) with no `aria-describedby` link.
- **What happens**: a screen reader announces a two-sentence paragraph as the name of a tiny
  button; the visible tooltip is not programmatically tied to it.
- **Why it hurts**: in a settings page with 30 hints, the accessible-name list becomes unreadable
  and the useful short name ("hint") is lost.
- **Severity**: Medium
- **Suggested fix**: give the button the short name ("提示 / Hint" or the field name) and connect
  the bubble with `aria-describedby`.

**F-40 — The search results cannot be reached by keyboard without tabbing through every row. — Medium**
- **Where**: `app.tsx:127` — the search `<form>`'s only key handler is `Escape`
  (`onKeyDown={event => { if (event.key === 'Escape') show() }}`); the results are `<button
  className="dt-open">` inside `<li>` (`app.tsx:63–68`, `app.tsx:80–97`).
- **What happens**: with up to 10 Tickets + Threads + 20 Triggers, a keyboard user must Tab
  through up to 31 buttons to reach the row they want; there is no ArrowDown/ArrowUp movement, no
  "Enter opens the first result", and no ⌘K / `/` shortcut to focus the search box at all.
- **Why it hurts**: global search is the fastest way to reach a Ticket or a Trigger, and it is the
  slowest to operate without a mouse.
- **Severity**: Medium
- **Suggested fix**: implement roving focus over the results with Arrow keys, open the first result
  on Enter from the input, and add a ⌘K / `/` shortcut.

**F-41 — The switch's visible label is a `<div>`, so it is not clickable. — Low**
- **Where**: `settings-kit.tsx:66–68` — `<div className="dt-field-head">{label}{hint && <InfoTip
  text={hint} />}</div><Switch checked={checked} onChange={onChange} label={label} />`.
- **What happens**: the text left of the toggle is not a `<label>`; clicking it does nothing.
- **Why it hurts**: a 13 px row with a toggle invites the click-on-the-text gesture that does
  nothing.
- **Severity**: Low
- **Suggested fix**: render the text as a `<label htmlFor>` bound to the switch's id.

### Empty / error states

**F-42 — Load errors are shown as the raw exception message. — Medium**
- **Where**: `widgets.tsx:113–117` — `if (error) return <p className="dt-error" role="alert">{error.message}</p>`.
- **What happens**: API errors are already localized by the caller (`api.ts:44–56`), but any other
  error — a thrown `Error` from a component, a parse failure — surfaces its raw message. The
  Sources settings group shows the same raw text (`source.tsx:115`, `source.tsx:121` via
  `healthText`).
- **Why it hurts**: an operator sees an English or developer-facing message in an otherwise
  localized UI and cannot tell whether the problem is theirs or the system's.
- **Severity**: Medium
- **Suggested fix**: wrap unknown errors in a localized "could not read …" message and keep the raw
  text in a collapsed detail.

**F-43 — The Sources settings group has no empty state. — Low**
- **Where**: `source.tsx:64–67` — `<div className="dt-form">{sources.map(…)}<ConfigHistory …/></div>`;
  there is no branch for `sources.length === 0`.
- **What happens**: with no Source kind installed the page renders an empty column followed by the
  history disclosure.
- **Why it hurts**: an empty page reads as a broken page.
- **Severity**: Low
- **Suggested fix**: render a "no sources installed" state naming the plugin that provides them.

**F-44 — The prompt history list has no empty state beyond a single line. — Low**
- **Where**: `prompts.tsx:272–282` — `[...view.revisions, …].map(…)`; `promptHistoryHint`
  (`locales.ts:596`) is shown above, but an empty list has no "no versions yet" row.
- **What happens**: with no saved versions the History tab shows only the hint line.
- **Why it hurts**: the operator cannot distinguish "no history yet" from "history failed to load".
- **Severity**: Low
- **Suggested fix**: add an explicit empty row.

### i18n

**F-45 — 67 of the 788 English strings live outside `locales.ts`. — Medium**
- **Where**: `locales.ts` imports `USER_ERRORS` (44 keys, `locales.ts` tail), `SETUP_PROBLEMS` (18)
  and `HEALTH_TEXT` (5) and reuses their English text: e.g. `'userError.notAttention': ['待人工决定…',
  USER_ERRORS.notAttention[1]]`, `'setup.foreignFile': ['…', SETUP_PROBLEMS.foreignFile[1]]`,
  `'healthCode.pollFailures': ['连续 {count} 次轮询失败…', HEALTH_TEXT.pollFailures]`.
- **What happens**: every one of the 788 keys has a Chinese literal, but for 72 of them the
  English is owned by the host's error/setup modules. A copy review of the English UI therefore
  cannot be done in `locales.ts` alone, and the panel's wording for setup problems and health
  codes can change under it when the host is upgraded.
- **Why it hurts**: the copy review the redesign depends on will miss 8.5 % of the English surface,
  and the panel's phrasing is not pinned by the plugin's own tests.
- **Severity**: Medium
- **Suggested fix**: keep the Chinese in `locales.ts` but give the 72 keys their own English
  literals (or a versioned snapshot of the host text), so the panel's English is reviewable and
  stable.

**F-46 — The glossary's language detection is a string comparison against one key. — Low**
- **Where**: `app.tsx:30` — `const chinese = t('tab.overview') === zh['tab.overview']`.
- **What happens**: the glossary decides which language is "own" by comparing one translated
  string with the zh dictionary. If the host adds a third locale, or if `tab.overview` is ever
  changed in one place only, the glossary silently swaps its columns.
- **Why it hurts**: a fragile coupling for a structural decision.
- **Severity**: Low
- **Suggested fix**: read the active language from the locale service rather than inferring it.

### Global search (header)

**F-47 — The results are one flat list with no group headers. — Medium**
- **Where**: `app.tsx:80–97` — a single `<ul className="dt-list">` containing Tickets, then
  Threads, then Triggers, with no heading between them; the kind is only a small `<span>` in the
  meta row (`app.tsx:83`, `:87`, `:93`).
- **What happens**: the header says "Found 3 Tickets, 1 Threads and 5 Triggers" but the list below
  gives no visual grouping; the operator must read each row's small type label to know what kind
  of thing they are looking at.
- **Why it hurts**: mixed result kinds in one list make scanning much slower, and the order
  (Tickets → Threads → Triggers) is not signposted.
- **Severity**: Medium
- **Suggested fix**: render three labelled groups, matching the three counts already in the header.

**F-48 — The 20-item cap is reported for Triggers only; the 10-item Ticket cap is silent. — Medium**
- **Where**: the server truncates tickets to 10 and Triggers to 20
  (`src/app/views/threads.ts:76`, `:87`); the client decides whether to show the "capped" wording
  from the Trigger count alone (`app.tsx:76` — `result.items.length >= 20 ? 'searchFoundCapped' :
  'searchFound'`).
- **What happens**: a search matching 40 tickets returns 10 and the header says "Found 10 Tickets"
  with no hint that 30 were dropped. A search matching exactly 20 Triggers says "the first 20
  Triggers (narrow the search)" even when 20 was the true total.
- **Why it hurts**: the operator believes the result set is complete when it is not — the same
  honesty problem as F-30, but with the cap only half-reported.
- **Severity**: Medium
- **Suggested fix**: have the API return per-kind totals and truncation flags, and render them.

**F-49 — Thread results are not highlighted. — Low**
- **Where**: `app.tsx:85` — `name={readableMarkers(t, thread.title)}`, while Tickets use
  `<Highlight text={ticket.title} query={query} />` (`app.tsx:81`) and Triggers use it too
  (`app.tsx:90`).
- **What happens**: a thread matched by a `#12` reference or a URL shows no indication of why it
  matched.
- **Why it hurts**: the operator cannot tell whether the match was on the title or on the reference
  that named it.
- **Severity**: Low
- **Suggested fix**: highlight the matching reference in the thread row as well.

**F-50 — Results are buttons, not links. — Low**
- **Where**: `app.tsx:65` — `<button type="button" className="dt-open" onClick={open}>`.
- **What happens**: each result navigates on click, but there is no `href`, so middle-click,
  Ctrl/Cmd-click, "open in new tab" and "copy link" are all unavailable; combined with F-04 the
  result cannot be shared at all.
- **Why it hurts**: the operator who wants to send a colleague a specific Ticket found through
  search has no way to produce a link.
- **Severity**: Low
- **Suggested fix**: make results anchors whose `href` encodes the route once the route model is
  URL-addressable.

---

## 3. What works well

These are real strengths, verified in the code, and the redesign should preserve them.

1. **The draft engine is genuinely well made.** `draft.tsx:21–50` implements a proper three-way
   merge (`merge3`) with per-key merging for objects and per-element merging for keyed lists
   (`id` / `chatId`), recording conflicts rather than silently overwriting. A concurrent save from
   another operator rebases the local draft instead of discarding it (`draft.tsx:95–106`).
2. **Drafts survive reloads and group switches.** Every draft is persisted to `sessionStorage`
   (`draft.tsx:144–148`) and rehydrated on mount with a "draft restored" notice
   (`draft.tsx:139–141`). Switching Settings groups keeps a pending edit.
3. **The conflict copy is specific and actionable.** `promptConflict` / `promptConflictParts`
   (`locales.ts:611–612`) name the revision and the exact parts that collided; `saveConflict` /
   `saveMerged` / `saveRebasing` (`locales.ts:518–520`) cover the three outcomes of a concurrent
   edit.
4. **Configuration history shows a real diff, not a timestamp list.** `changeText`
   (`settings-kit.tsx:107–118`) renders "接单模式：关闭 → 自动接单", "新增规则：…",
   "Redmine · 接收范围：…" per field, with the source and field names resolved to their labels.
   This is far more useful than the usual "v12, 2 minutes ago".
5. **The prompt "Default updated" flow matches its spec.** `docs/004-prompts.md:40` requires that an
   upgrade which changes an overridden default be marked and diffed, with a keep-mine / take-default
   choice. `prompts.tsx:161–171` and `prompt-config.ts:115–118` implement exactly that, including the
   "the old default was not recorded" fallback described in `docs/004-prompts.md:40` and
   `docs/005-panel.md:58`.
6. **The full-prompt diff folds unchanged sections.** `prompts.tsx:242–244` shows only what the
   draft changed and collapses the rest to "与已保存相同 / Same as saved", with a
   `lineDiff` that folds runs of more than four unchanged lines (`prompt-config.ts:57–77`).
7. **The token discipline in `client.css` is excellent.** 30 distinct `--dsw-alias-*` tokens are
   used, and every one of them exists in the host theme (verified against
   `dsh-client-ui-theme/lib/client.js`). Only two non-token colour values appear in the whole
   514-line file, both defensible.
8. **Focus is deliberately managed around saves.** `Fields` (`settings-kit.tsx:45–55`) records the
   focused input before the fieldset is disabled during a save and restores it afterwards;
   `SaveBar` (`draft.tsx:186–191`) returns focus to the block when the bar disappears.
9. **The modal is a proper dialog.** `Modal` (`controls.tsx:183–215`) implements a focus trap with a
   DOM-order-safe `querySelectorAll('*')` filter, Escape and backdrop dismissal, and focus
   restoration to the opener — and the tooltip does the same for its trigger.
10. **`InfoTip` supports touch and keyboard**, not just hover (`controls.tsx:238–248`: hover,
    `:focus-visible`, `pointerup` for touch, Escape to dismiss, and it closes on scroll/resize).
11. **The Ticket row really is one component.** `TicketLine` (`rows.tsx:10–44`) is used by the
    Overview "needs action" list (`overview.tsx:71`) and by the Execution list (`execution.tsx:46–48`),
    so a Ticket looks the same in both places — exactly what `docs/005-panel.md:74` asks for.
12. **Setup problems are correctly separated.** A deployment-wide problem is shown once at the top of
    the Source page (`source.tsx:146–152`) and the per-Source notes are suppressed while it is
    unresolved (`source.tsx:103–104`), so the operator is not told the same thing twice.
13. **Every user-facing string is in one bilingual dictionary with a Chinese translation** — 788
    keys, 788 Chinese literals, no ad-hoc Chinese in the components.
14. **The deployment page degrades honestly.** When the host offers no configuration form, or the
    browser is remote, or the service is still starting, the page says which of the four situations
    it is in (`deployment.tsx:49–51`) and offers no save affordance at all
    (`deployment.tsx:85`).
15. **The prompt editor keeps its state honestly.** The origin of the draft is tracked and shown —
    "from version 12", "from the current defaults", "section default restored"
    (`prompts.tsx:16–18`, `originText`), and the save bar shows the base revision and the number of
    changed sections (`prompts.tsx:52`).
16. **The Search empty state teaches.** `searchNone` (`locales.ts:107`) lists every accepted query
    form — Trigger text, a Redmine issue link or `#number`, a Gerrit change link, a Feishu message
    link, an `om_` id — instead of saying "no results".

---

## 4. Metrics

Counts were taken mechanically from the working tree (regex/AST-free parsing of the files; the
method is reproducible with the commands in the notes below).

### Strings and localization

| Metric | Value | How it was counted |
| --- | --- | --- |
| Total strings in `src/client/locales.ts` | **788** | keys of the `TEXT` object; all unique, no duplicates |
| Keys with a Chinese translation | **788 (100 %)** | every entry's first tuple element is a Chinese literal |
| Keys whose **English** comes from a host constant | **67** | `userError.*` → `USER_ERRORS.*[1]` (44), `setup.*` → `SETUP_PROBLEMS.*[1]` (18), `healthCode.*` → `HEALTH_TEXT.*` (5) |
| Keys identical in both languages | **11** | `title`, `empty`, `source.redmine`, `source.gerrit`, `health.runtime`, `panel`, `pmsAgent`, `assignmentSpan`, `endedAtShort`, `glossaryChinese`, `glossaryEnglish` — all proper nouns or locale-neutral format strings |
| Glossary terms | **28** | `GLOSSARY` (`locales.ts` tail): roles 3, source 2, trigger 6, eval 9, execution 8 |
| Glossary value groups | **5** | `GLOSSARY_VALUES`: decision, strength, ticket, assignment, report |

### Controls and fields

| Metric | Value |
| --- | --- |
| Exported primitives in `controls.tsx` | **13** (`Icon`, `Button`, `Tag`, `Pill`, `SegmentedTabs`, `SegmentedControl`, `Input`, `Switch`, `StateDot`, `Dot`, `DisclosureRow`, `Modal`, `InfoTip`) |
| `FieldSpec` field types the settings renderer supports | **6** (`switch`, `select`, `number`, `text`, `fact`, `rows`) — `src/sources/kind.ts:16–22` |
| Source configuration fields | **26** spec fields + **3** enable switches = **29** editable controls (Feishu 6+1, Redmine 8+1, Gerrit 12+1) |
| Eval group editable controls | **~28 fixed** (5 per-Source policy controls + 18 admission selects + 5 Eval settings) **+ 3 per rule + 3 per chat row** |
| Execution group editable controls | **7** (model provider/model/effort, maxWorkers, directory, prepare, blocked commands) |
| Prompts group editable text areas | **19** (3 team sections + 16 built-in parts) **+ N skills** |
| Deployment group editable controls | **3** numeric + 1 read-only path |
| **Total fixed editable settings fields** | **≈ 86** (excluding repeatable rules, allowed-list rows, chat rows and skills) |
| Settings groups with a visible save affordance | **5 of 5** (Deployment's only when the host form is writable) |
| `SaveBar` instances at runtime | **8** — Sources 3 (`source.tsx:56`), Eval 2 (`eval.tsx:190`, `:217`), Execution 1, Prompts 1, Deployment 1 |
| `ConfigHistory` instances | **3** (Sources, Eval, Execution). Prompts uses a separate `PromptHistory`; **Deployment has none** |

### Visual system

| Metric | Value |
| --- | --- |
| Distinct `--dsw-alias-*` tokens used | **30** (all verified to exist in the host theme) |
| Distinct font sizes in `client.css` | **10** — 11, 12, 13, 14, 15, 16, 17, 20, 22, 28 px (4 of them off the host's scale) |
| Host type-scale tokens used by the panel | **0** of the 8 the host defines (`--dsw-font-xxxs-11` … `--dsw-font-xl-24`) |
| Hard-coded non-token colours | **2 distinct values, 4 occurrences** — `#000` ×3 (mask-image gradients, `client.css:246–248`) and `green` ×1 (fallback inside `color-mix`, `client.css:231`) |
| Hard-coded colours that are *not* token-backed | **0** otherwise; every other colour in the file is a `var(--dsw-*)` reference |
| Host primitives re-implemented locally | **9** of the 13 exported: `Button`, `Pill`, `Input`, `Modal`, `Tooltip`→`InfoTip`, `Toast`, `StateDot`, `DisclosureRow`, icons (35 hand-drawn paths) |
| Container/media breakpoints | **5** `@container (max-width: 640px)` blocks + **2** `@media (prefers-reduced-motion: reduce)` + **1** `@media (hover: none)` |

### Interaction and accessibility

| Metric | Value |
| --- | --- |
| Undo steps available anywhere in the panel | **0** |
| `beforeunload` guards | **0** |
| Keyboard shortcuts (⌘K, ⌘S, `/`) | **0** |
| Save bars with an explicit "Saving…" state | **0 of 8** (all show "Unsaved · draft kept" while saving) |
| Save bars with an undo / revert-to-last-save action | **0 of 8** |
| Tab strips with `role="tab"` but no `tabpanel`/`aria-controls` | **2** (Prompts sub-tabs, Eval per-Source sub-tabs) |
| Search results with arrow-key navigation | **no** (Tab only) |
| Search result groups rendered with headings | **0** (one flat list of 3 kinds) |
| Search caps | Tickets **10** (silent), Triggers **20** (reported), Threads **uncapped** |
| Settings drafts persisted to `sessionStorage` | **7 of 8** — the Deployment draft (`deployment.tsx:38`) passes no `key` and is lost on reload |
| Drafts shared between the panel and the Plugin Manager's Deployment page | **0** — two independent `useDraft` instances over one host `ConfigForm` |
| Settings surfaces rendered in two places with different content | **1** — the Deployment page (`settings.tsx:23` vs `deployment.tsx:94`) |

---

## Appendix — quick reproduction of the counts

```bash
cd /Users/dengguiling/workspace/superagent/dsh-superagent-prototype

# locale keys (788, all unique)
node -e "const s=require('fs').readFileSync('src/client/locales.ts','utf8');
const b=s.slice(s.indexOf('const TEXT = {'), s.indexOf('} as const satisfies'));
const k=[...b.matchAll(/^  (?:'([^']+)'|([A-Za-z0-9_]+)): \[/gm)].map(m=>m[1]||m[2]);
console.log(k.length, new Set(k).size)"

# tokens, font sizes, hard-coded colours
grep -o 'var(--dsw-alias-[a-zA-Z0-9-]*' src/client/client.css | sort -u | wc -l   # 30
grep -o 'font-size:[^;]*' src/client/client.css | sort -u | wc -l               # 10
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' src/client/client.css              # 3 (mask #000)

# save bars, histories, undo, guards
grep -rn '<SaveBar' src/client/            # 6 sites / 8 instances
grep -rn '<ConfigHistory' src/client/      # 3
grep -rn 'undo' src/client/                # 0
grep -rn 'beforeunload' src/               # 0
```

### Host package checked for the F-32 claim

```
@deepseek-ai/dsh-client-ui-primitives/lib/types/index.d.ts
  exports Button, Pill, Input, Modal, Tooltip, Toast, StateDot, DisclosureRow,
         Menu, HoverCard, RiskConfirmation, OnboardingSurface, DiffBlock,
         MarkdownText, … and the full ic_ds_* icon set
```
(found under `~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-client-ui-primitives`; the package is a
`devDependency` of the host's own `dsh-client-ui-model-selection`, and is **not** listed in this
plugin's `package.json`.)
