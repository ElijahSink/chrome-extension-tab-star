# Presets

Presets live in `presets.js` and are shared by the popup and the service worker. Each one is a starting point
for a rule: select it in the popup, adjust if needed, test, save.

**Verified** means the selector has been confirmed against the live product. Unverified presets were derived
from each product's markup and may need adjustment for your instance or version. Use **Test on Current Tab**
and the [targeting guide](targeting-status.md) to fix them, then please contribute the fix.

| Service | URL regex | Tab group title | Status fields (selector → keep only, label) | Verified |
| --- | --- | --- | --- | --- |
| Jira (Cloud & Data Center) issue | `/browse/([A-Z][A-Z0-9_]+-\d+)` | `$1` | `[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val` | Yes |
| GitHub pull request / issue | `github\.com/[^/]+/([^/]+)/(?:pull\|issues)/(\d+)` | `$1#$2` | `[data-testid="header-state"], .gh-header-meta .State, .gh-header-sticky .State` | No |
| GitLab merge request (+ pipeline) | `/([^/]+)/-/merge_requests/(\d+)` | `$1!$2` | 1: `.merge-request-sticky-header .detail-page-description .gl-badge .gl-badge-content, .merge-request-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issuable-status-badge"] .gl-badge-content`<br>2: `.mr-pipeline-title` → `#\d+\s+(\S+)`, label `CI` | Yes |
| GitLab issue | `/([^/]+)/-/issues/(\d+)` | `$1#$2` | `.issuable-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issue-state-badge"] .gl-badge-content, [data-testid="work-item-state-badge"], .issuable-status-badge` | No |
| GitLab pipeline | `/([^/]+)/-/pipelines/(\d+)` | `$1 pipeline #$2` | `[data-testid="pipeline-details-header"] [data-testid="ci-icon-text"], [data-testid="ci-icon-text"]` | Yes |
| Azure DevOps work item | `dev\.azure\.com/[^/]+/([^/]+)/_workitems/edit/(\d+)` | `$1 #$2` | `input[aria-label="State Field"], [aria-label="State Field"] input` | No |
| ServiceNow incident | `\b(INC\d{7,})\b` | `$1` | `select[id$=".state"] option:checked, [aria-label="State"] input` | No |

## Notes per service

**Jira.** Example result: `ABC-123 - In Progress`. The first selector targets the status button on Jira Cloud,
the second the status field on Jira Server/Data Center.

**GitHub.** Example result: `hello-world#42 - Open`. Reads Open, Draft, Merged or Closed from the header badge.
For GitHub Enterprise, replace `github\.com` in the regex with your hostname.

**GitLab merge request.** Example result: `project!17 - Open · CI passed`. Hostname-agnostic. Verified against a
full MR page dump from GitLab 19.3 (self-managed, October 2026). The state badge lives in the sticky header:

```
.merge-request-sticky-header > .detail-page-description > span.gl-badge[aria-label="Open"] > span.gl-badge-content
```

It is *not* inside `.detail-page-header`; that row contains the "Try Rapid Diffs · Beta" badge, and the tab
strip contains count badges, all using `.gl-badge-content`. Anchoring on `.detail-page-description` avoids
both. Field 2 reads `p.mr-pipeline-title` ("Pipeline #18395789 passed") and keeps the last word. The older
`.issuable-status-badge` selectors remain as fallbacks for other GitLab versions. Field 2 reads the pipeline widget
`<p class="mr-pipeline-title">Pipeline <a>#18395789</a> passed</p>` and keeps the last word. MRs without a
pipeline show only field 1.

**GitLab issue.** Example result: `project#5 - Open`. Same badge markup as merge requests.

**GitLab pipeline.** Example result: `project pipeline #18395616 - Blocked`. The status text lives in
`<span data-testid="ci-icon-text">` inside the pipeline header (confirmed on self-managed GitLab, October 2026).
Job badges lower on the page reuse the same test id, so the header-scoped selector is listed first.

**Azure DevOps.** Example result: `Project #1234 - Active`. The State field is an `<input>`, so the reader uses
its value. For `*.visualstudio.com` hosts edit the regex.

**ServiceNow.** Example result: `INC0010042 - In Progress`. The incident number is not in the URL, so the regex
matches the tab title. Classic UI renders the form inside an iframe; the reader searches all frames. Workspace
(Next Experience) layouts may need a different selector.

## Adding a preset

Add an object to `STATUS_PRESETS` in `presets.js`:

```js
{
  id: 'linear',                       // unique, kebab-case
  name: 'Linear - Issue',             // shown in the popup menu and used as the default Rule Name
  regex: 'linear\\.app/[^/]+/issue/([A-Z0-9]+-\\d+)',
  groupName: '$1',
  statusFields: [
    { selector: '...' },                                // comma-separated fallbacks allowed
    { selector: '...', extract: '(\\w+)$', label: 'CI' }, // optional extra fields
  ],
  exampleUrl: 'https://linear.app/team/issue/ENG-42/slug',
  exampleTitle: 'ENG-42 - In Progress',
  verified: false,                    // flip to true once confirmed on the live product
  notes: 'One or two sentences shown under the menu when selected.',
}
```

Regex strings are JavaScript string literals, so escape backslashes twice (`\\d`, `\\.`). Reload the extension
from `chrome://extensions` and the preset appears in the popup.
