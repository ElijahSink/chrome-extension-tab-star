/**
 * Shared between the popup (<script src="presets.js">) and the service worker
 * (importScripts('presets.js')). Keep this file free of DOM and chrome.* calls.
 *
 * Each preset is a starting point for a rule. `regex` is matched against the tab URL
 * first and then the tab title. `groupName` may use $1..$9 to insert capture groups.
 *
 * `statusFields` is a list of elements to read. Each field has:
 *   selector - CSS selector (comma-separated fallbacks allowed); the first matching
 *              element with text wins
 *   extract  - optional regex applied to that text; the first capture group (or the
 *              whole match) is kept, e.g. '#\\d+\\s+(\\S+)' turns
 *              "Pipeline #18395789 passed" into "passed"
 *   label    - optional prefix, e.g. 'CI' gives "CI passed"
 * Values from all fields are joined with STATUS_JOINER: "Open · CI passed".
 *
 * `verified: true` means the selectors have been confirmed against the live product.
 * Everything else is a best-effort starting point: use "Test on Current Tab" to confirm.
 */

/**
 * Bump whenever background.js or presets.js changes. The popup compares its copy
 * with the running service worker's copy and offers a reload when they differ,
 * because Chrome keeps running the old worker until the extension is reloaded.
 */
const EXTENSION_BUILD = 8;

const DEFAULT_STATUS_SELECTOR =
  '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val';

/** Separator between values when a rule reads several status fields. */
const STATUS_JOINER = ' · ';

/**
 * Returns the status fields of a rule or preset in normalised form. Rules saved
 * before multi-field support only have `statusSelector`; that becomes one field.
 */
function normalizeStatusFields(ruleOrPreset) {
  const clean = (f) => ({
    selector: ((f && f.selector) || '').trim() || DEFAULT_STATUS_SELECTOR,
    extract: ((f && f.extract) || '').trim(),
    label: ((f && f.label) || '').trim(),
  });
  if (Array.isArray(ruleOrPreset.statusFields) && ruleOrPreset.statusFields.length) {
    return ruleOrPreset.statusFields.map(clean);
  }
  return [clean({ selector: ruleOrPreset.statusSelector })];
}

/** One-line human summary of a rule's status fields, for the popup list. */
function describeStatusFields(ruleOrPreset) {
  return normalizeStatusFields(ruleOrPreset)
    .map((f) => {
      let s = f.selector;
      if (f.extract) s += ` → /${f.extract}/`;
      if (f.label) s = `${f.label}: ${s}`;
      return s;
    })
    .join(STATUS_JOINER);
}

const STATUS_PRESETS = [
  {
    id: 'jira',
    name: 'Jira (Cloud & Data Center) - Issue',
    regex: '/browse/([A-Z][A-Z0-9_]+-\\d+)',
    groupName: '$1',
    statusFields: [{ selector: DEFAULT_STATUS_SELECTOR }],
    exampleUrl: 'https://yourcompany.atlassian.net/browse/ABC-123',
    exampleTitle: 'ABC-123 - In Progress',
    verified: true,
    notes: 'Groups each ticket by key. Works on Jira Cloud (data-testid) and Jira Server/Data Center (#status-val).',
  },
  {
    id: 'github',
    name: 'GitHub - Pull Request / Issue',
    regex: 'github\\.com/[^/]+/([^/]+)/(?:pull|issues)/(\\d+)',
    groupName: '$1#$2',
    statusFields: [
      { selector: '[data-testid="header-state"], .gh-header-meta .State, .gh-header-sticky .State' },
    ],
    exampleUrl: 'https://github.com/octocat/hello-world/pull/42',
    exampleTitle: 'hello-world#42 - Open',
    verified: false,
    notes: 'Reads Open, Draft, Merged or Closed from the header badge. For GitHub Enterprise replace github\\.com with your hostname.',
  },
  {
    id: 'gitlab-mr',
    name: 'GitLab - Merge Request (+ pipeline)',
    regex: '/([^/]+)/-/merge_requests/(\\d+)',
    groupName: '$1!$2',
    statusFields: [
      {
        // Confirmed on GitLab 19.3 (self-managed, Oct 2026): the state badge is
        //   .merge-request-sticky-header > .detail-page-description > span.gl-badge[aria-label=Open] > .gl-badge-content
        // It is NOT inside .detail-page-header; that row holds the "Try Rapid Diffs · Beta" badge,
        // and the tab strip holds count badges, so stay anchored on .detail-page-description.
        selector:
          '.merge-request-sticky-header .detail-page-description .gl-badge .gl-badge-content, .merge-request-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issuable-status-badge"] .gl-badge-content',
      },
      {
        selector: '.mr-pipeline-title',
        extract: '#\\d+\\s+(\\S+)',
        label: 'CI',
      },
    ],
    exampleUrl: 'https://gitlab.com/group/project/-/merge_requests/17',
    exampleTitle: 'project!17 - Open · CI passed',
    verified: true,
    notes: 'Hostname-agnostic. Field 1 reads Open / Merged / Closed / Draft from the state badge in the sticky header. Field 2 reads the MR pipeline widget ("Pipeline #123 passed") and keeps only the last word. MRs without a pipeline just show the first field.',
  },
  {
    id: 'gitlab-issue',
    name: 'GitLab - Issue',
    regex: '/([^/]+)/-/issues/(\\d+)',
    groupName: '$1#$2',
    statusFields: [
      { selector: '.issuable-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issue-state-badge"] .gl-badge-content, [data-testid="work-item-state-badge"], .issuable-status-badge' },
    ],
    exampleUrl: 'https://gitlab.com/group/project/-/issues/5',
    exampleTitle: 'project#5 - Open',
    verified: false,
    notes: 'Hostname-agnostic. Reads Open or Closed from the header badge.',
  },
  {
    id: 'gitlab-pipeline',
    name: 'GitLab - Pipeline',
    regex: '/([^/]+)/-/pipelines/(\\d+)',
    groupName: '$1 pipeline #$2',
    statusFields: [
      { selector: '[data-testid="pipeline-details-header"] [data-testid="ci-icon-text"], [data-testid="ci-icon-text"]' },
    ],
    exampleUrl: 'https://gitlab.com/group/project/-/pipelines/18395616',
    exampleTitle: 'project pipeline #18395616 - Passed',
    verified: true,
    notes: 'Hostname-agnostic. Reads Passed, Failed, Running, Blocked, Pending or Canceled from the pipeline header badge (span[data-testid="ci-icon-text"]).',
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps - Work Item',
    regex: 'dev\\.azure\\.com/[^/]+/([^/]+)/_workitems/edit/(\\d+)',
    groupName: '$1 #$2',
    statusFields: [{ selector: 'input[aria-label="State Field"], [aria-label="State Field"] input' }],
    exampleUrl: 'https://dev.azure.com/org/Project/_workitems/edit/1234',
    exampleTitle: 'Project #1234 - Active',
    verified: false,
    notes: 'The State field is an input control; the reader uses its value. For *.visualstudio.com hosts edit the regex.',
  },
  {
    id: 'servicenow',
    name: 'ServiceNow - Incident',
    regex: '\\b(INC\\d{7,})\\b',
    groupName: '$1',
    statusFields: [{ selector: 'select[id$=".state"] option:checked, [aria-label="State"] input' }],
    exampleUrl: 'https://yourcompany.service-now.com/nav_to.do?uri=incident.do?sys_id=...',
    exampleTitle: 'INC0010042 - In Progress',
    verified: false,
    notes: 'The incident number is not in the URL, so this matches the tab title. The classic UI renders the form in an iframe; the reader searches all frames.',
  },
];

function getPreset(id) {
  return STATUS_PRESETS.find((p) => p.id === id) || null;
}
