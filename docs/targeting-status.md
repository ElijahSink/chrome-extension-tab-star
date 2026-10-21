# Targeting the status field

TabStar Status appends a short piece of text from a web page to the tab group name, for example
`ABC-123 - In Progress`. You tell it *which* text by giving a **CSS selector** for the element that holds the
status. This guide shows how to find a selector that keeps working.

The same content is bundled in the extension as `help.html`, reachable from the popup's
"How do I find the selector?" link.

## What a CSS selector is

A CSS selector is the address of one element on a web page. Web developers use selectors to style elements;
TabStar Status uses one to find the element whose text it should copy into the group title.

| Selector | Reads as |
| --- | --- |
| `#status-val` | the element with `id="status-val"` |
| `[data-testid="header-state"]` | the element whose `data-testid` attribute equals `header-state` |
| `input[aria-label="State Field"]` | an `<input>` whose `aria-label` attribute equals `State Field` |
| `.gh-header-meta .State` | an element with class `State` inside an element with class `gh-header-meta` |

The extension takes the first element the selector matches that has any text, trims it, and appends it to the
group title after ` - `. For `<input>` and `<select>` elements it uses the current value instead of the text.

## 1. Try a preset first

The popup's **Start from a preset** menu covers Jira, GitHub, GitLab, Azure DevOps and ServiceNow. A preset
fills in the URL regex, the group name template and the selector. See [presets.md](presets.md) for the exact
values. Presets marked *(unverified)* are best-effort: open a matching page and click **Test on Current Tab**.

## 2. Find the element in DevTools

1. Open the page that shows the status.
2. Right-click the status text or badge and choose **Inspect**.
3. If the highlighted node is a tiny inner `<span>`, walk up one or two parents until you find one with a
   stable identifying attribute.
4. Right-click the node in the Elements panel, **Copy › Copy selector**, then simplify it.

## 3. Prefer stable attributes

Generated class names like `.css-1x9kq2` change on every deploy. Choose, in this order:

| Attribute | Example |
| --- | --- |
| `data-testid` / `data-test-id` | `[data-testid="header-state"]` |
| `id` | `#status-val` |
| `aria-label` | `input[aria-label="State Field"]` |
| Semantic class names | `.gh-header-meta .State` |

Suffix matching helps with prefixed ids: `select[id$=".state"]` matches `incident.state`, `problem.state`, etc.

## 4. Verify in the Console

Paste the selector into the DevTools Console to see exactly what the extension will read:

```js
document.querySelector('[data-testid="header-state"]').textContent.trim()
```

If the status lives in an `<input>` or `<select>`, the extension reads the input's value or the selected
option's text automatically. In the console use `.value` instead of `.textContent`.

## 5. Add fallbacks

Comma-separate several selectors. They are tried **in the order written**; the first one that finds an element
with non-empty text wins. (This differs from plain `querySelectorAll`, which returns matches in page order.)
Put the most specific selector first and avoid a generic last resort such as `.badge`: pages often contain
other badges, like GitLab's "Beta" label, that would be picked up when the specific ones miss.
The Jira preset covers Cloud and Data Center this way:

```
[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val
```

## Reading more than one thing

A rule can have several **status fields**. Each field reads one element; the values are joined with ` · `.
This is how the GitLab merge request preset shows both the MR state and its pipeline:

| Field | Selector | Keep only | Label | Reads |
| --- | --- | --- | --- | --- |
| 1 | `.detail-page-header .gl-badge-content` | | | `Open` |
| 2 | `.mr-pipeline-title` | `#\d+\s+(\S+)` | `CI` | `CI passed` |

Result: `www!42 - Open · CI passed`.

**Keep only** is a regex applied to the element's text. If it has parentheses, only that part is kept, otherwise
the whole match. The pipeline widget's text is `Pipeline #18395789 passed`; `#\d+\s+(\S+)` keeps the word after
the number. Matching is case-insensitive. The test result shows both the raw text and what was kept.

**Label** is a plain prefix so the reader knows which value is which.

A field whose element never appears (an MR with no pipeline) is simply left out. The group title is only
updated after every field has a value or the wait has timed out, whichever comes first.

## 6. Test, then save

Click **Test on Current Tab** in the popup. Nothing is grouped. The result shows the resolved group name, the
status the selector found, and a preview of the final title.

| Result | Meaning |
| --- | --- |
| regex did not match | The URL regex matches neither the URL nor the title. Check escaping (`\.` for dots). |
| access was not granted | You declined site access. Click Test again and allow it. |
| matched no element within 3 seconds | Wrong selector, or the element renders very late. Re-inspect and try a parent. |
| matched N element(s) but none had any text | You selected a wrapper or an icon. Try the parent, or the inner element that holds the words. |
| "Keep only" regex did not match | The element text is shown; adjust the regex to it. |

A successful test shows, per field, the value, the raw text it was kept from, and the element that supplied it,
such as `button[data-testid="issue-field-status..."]`. If that is not the element you expected, tighten the
selector.

## Rule name vs. tab group title

- **Rule Name** is only a label for the list in the popup. It never appears in Chrome's tab strip.
- **Tab Group Title** is what the group is actually called. It may contain `$1` … `$9`, which are replaced by
  the parts of the URL you wrapped in parentheses in the regex.

| Regex | Tab Group Title | URL | Resulting group |
| --- | --- | --- | --- |
| `/browse/([A-Z]+-\d+)` | `$1` | `.../browse/ABC-123` | `ABC-123` |
| `github\.com/[^/]+/([^/]+)/pull/(\d+)` | `$1#$2` | `.../hello-world/pull/42` | `hello-world#42` |
| `github\.com/` | `GitHub` | any GitHub page | `GitHub` (one fixed group) |

Rules created with the original Tab Star used a "Use capture group" checkbox instead of `$1`. They still work
unchanged. Opening one in the editor shows it as `$1`; saving converts it to the template form.

## Keeping titles short

Chrome renders a tab group title on one line inside the coloured chip and truncates it with an ellipsis when the
tab strip is crowded, cutting off the end, which is where the status lives. The popup's **Max group title
length** setting fixes this by shortening the *base name* instead and always keeping the status:

| Setting | Title |
| --- | --- |
| 0 (no limit) | `perimeterx-lambda-at-edge pipeline #18395616 - Blocked` |
| 32 | `perimeterx-lambda-at-… - Blocked` |
| 20 | `perimeter… - Blocked` |

Rules: the base is never cut below 8 characters, so ticket keys like `ABC-123` stay whole even if that means
the title exceeds the limit with a very long status. Limits below 12 are raised to 12. Changing the setting
re-titles all open groups.
The test result shows the shortened title so you can see the effect before saving.

Prefer short templates and labels too: `$1 !$2` beats `$1 merge request #$2`, and `CI` beats `Pipeline`.

## Things to know

- **Frames.** The reader searches the main page and every same-origin iframe, so classic ServiceNow forms work.
- **Live updates.** After the first read the extension watches the page. Changing the status without reloading
  renames the group too.
- **Timing.** On page load the reader waits up to 10 s for the element. The Test button waits 3 s.
- **Permissions.** Only origins you grant are read. The prompt appears when you save or test a rule.
- **One status per group.** If several tabs in a group report a status, the most recent read wins.
