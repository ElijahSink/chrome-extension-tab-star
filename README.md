# TabStar Status

A proof-of-concept fork of [ElijahSink/chrome-extension-tab-star](https://github.com/ElijahSink/chrome-extension-tab-star)
that groups tabs by URL regex **and appends a live status read from the page to the tab group name**.

The motivating use case is Jira: a rule groups every tab for ticket `ABC-123` under a group called `ABC-123`,
which becomes `ABC-123 - In Progress` once the ticket page loads and follows the ticket through its workflow.
The same mechanism works for GitHub pull requests, GitLab merge requests, Azure DevOps work items, ServiceNow
incidents, or any page with a status element you can point a CSS selector at.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the repo root.
3. Pin the extension. If the original Tab Star is installed, disable it so the two do not fight over groups.

There is no build step. Reload the extension from `chrome://extensions` after editing `background.js`,
`presets.js` or `manifest.json`. Popup changes only need the popup reopened. If the popup shows a yellow
"Reload extension" banner, the background script is out of date; click the button.

## Quick start with a preset

1. Open a page you want to track, e.g. a Jira issue, then open the popup.
2. Pick a service from **Start from a preset**. The regex, group name template and status selector fill in.
   **Site Origin** is pre-filled from the current tab.
3. Click **Test on Current Tab**. Allow site access when Chrome asks. The result shows the group name the rule
   produces, the status it found and a preview such as `ABC-123 - In Progress`. Nothing is grouped yet.
4. Click **Add Pattern**, then **Apply to Current Tab**.

Refreshing the page re-reads the status. Changing the status in the product's UI without a reload also updates
the group name, because the injected reader watches the page for changes.

## Writing your own rule

The form is split into three questions.

**1. Which tabs?**

| Field | Purpose |
| --- | --- |
| Rule Name | Only shown in the rule list so you can tell rules apart. |
| URL Regex Pattern | Matched against the tab URL, then the tab title. Wrap the part you want to reuse in `( )`. |

**2. What should the tab group be called?**

| Field | Purpose |
| --- | --- |
| Tab Group Title | `$1` inserts the first captured part, `$2` the second. Plain text gives every matching tab the same fixed title. |
| Random color | Give each new group a random color instead of the chosen one. |

**3. Show a status from the page? (optional)**

| Field | Purpose |
| --- | --- |
| Append the page's status | Enables status extraction for tabs matched by this rule. |
| Status fields | One or more elements to read. Each has a CSS selector, an optional "Keep only" regex and an optional label. Values are joined with ` · `. |
| Site Origin | Site to request access for. Pre-filled from the active tab. |

Example: a GitLab merge request rule with two fields, the header badge and the pipeline widget, gives
`www!42 - Open · CI passed`.

**Settings.** The popup has one global setting, **Max group title length**. Chrome shows group titles on a single
line and truncates long ones itself, so a long project name can hide the status. With a limit set, the base name
is shortened with `…` and the status suffix is always kept, e.g. `perimeterx-la… - Blocked`. Changing the limit
re-titles every open group immediately. `0` means no limit.

The popup has an expandable "What is a CSS selector and how do I get one?" explainer next to the selector field.
For the long version read **[docs/targeting-status.md](docs/targeting-status.md)** (also bundled as `help.html`).
The shipped presets and how to add one are in **[docs/presets.md](docs/presets.md)**.

## Supported services

| Service | Example group title | Verified |
| --- | --- | --- |
| Jira Cloud & Data Center | `ABC-123 - In Progress` | Yes |
| GitHub pull request / issue | `hello-world#42 - Open` | No |
| GitLab merge request + its pipeline | `project!17 - Open · CI passed` | Yes |
| GitLab issue | `project#5 - Open` | No |
| GitLab pipeline | `project pipeline #18395616 - Blocked` | Yes |
| Azure DevOps work item | `Project #1234 - Active` | No |
| ServiceNow incident | `INC0010042 - In Progress` | No |

Unverified presets are best-effort starting points. If you confirm or fix one, flip `verified` in `presets.js`
and open a PR.

## How it works

- `background.js` (MV3 service worker) listens for tab loads, matches rules and groups tabs.
- A **group registry** in `chrome.storage.session` maps `windowId:baseName` to a group id, so a group renamed to
  `ABC-123 - Done` is still found when another `ABC-123` tab opens. If the registry is empty (service worker
  restart), it falls back to matching titles of the form `<base>` or `<base> - <anything>`.
- For rules with status enabled, `chrome.scripting.executeScript` injects `readStatusFromPage` into every frame
  of the tab. It waits up to 10 s for the status element, returns its text or value, and installs a
  `MutationObserver` that messages the service worker on later changes.
- The popup's **Test on Current Tab** runs the same matcher and reader against the active tab without grouping.
- Status reading needs host access for the page's origin. The extension declares only
  `optional_host_permissions`; the popup requests the specific origin when you save or test.

## Forking and releasing

This repo is a fork of ElijahSink/chrome-extension-tab-star. The release workflow in `.github/workflows` zips
the extension and uploads it to the Chrome Web Store when a tag is pushed. It needs four repository secrets
(`CI_GOOGLE_EXTENSION_ID`, `CI_GOOGLE_CLIENT_ID`, `CI_GOOGLE_CLIENT_SECRET`, `CI_GOOGLE_REFRESH_TOKEN`) tied to
your own Web Store listing. Without them, tag pushes build the zip artifact but fail on the upload step, which
is harmless. Loading unpacked needs none of this.

## Limitations (POC)

- Status is shown at the tab **group** level only. Per-tab titles are untouched. Group titles are single-line.
- One status per group: the most recently read tab wins.
- Group ids reset on browser restart, so the registry is session-scoped. Existing groups are re-adopted by title.
- Manually renaming a tracked group will be overwritten on the next status update.
- Cross-origin iframes are only searched if their origin has been granted too.
- Status text is capped at 80 characters.
- Single-page navigations are detected from URL changes. Apps that change content without changing the URL
  are only re-read via the live observer on the page, not re-grouped.
