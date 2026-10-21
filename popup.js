/* global EXTENSION_BUILD, STATUS_PRESETS, DEFAULT_STATUS_SELECTOR, STATUS_JOINER, getPreset, normalizeStatusFields, describeStatusFields */

const HELP_URL = chrome.runtime.getURL('help.html');

let currentPatternId = null;
let selectedColor = 'blue';

const patternList = document.getElementById('patternList');
const presetSelect = document.getElementById('presetSelect');
const presetHint = document.getElementById('presetHint');
const ruleName = document.getElementById('ruleName');
const regexPattern = document.getElementById('regexPattern');
const groupName = document.getElementById('groupName');
const useRandomColor = document.getElementById('useRandomColor');
const statusEnabled = document.getElementById('statusEnabled');
const statusFields = document.getElementById('statusFields');
const statusFieldList = document.getElementById('statusFieldList');
const addStatusFieldBtn = document.getElementById('addStatusField');
const statusOrigin = document.getElementById('statusOrigin');
const helpLink = document.getElementById('helpLink');
const addPatternBtn = document.getElementById('addPattern');
const testRuleBtn = document.getElementById('testRule');
const applyToCurrentBtn = document.getElementById('applyToCurrent');
const testResult = document.getElementById('testResult');
const staleBanner = document.getElementById('staleBanner');
const reloadExtensionBtn = document.getElementById('reloadExtension');
const maxTitleLength = document.getElementById('maxTitleLength');
const maxTitleHint = document.getElementById('maxTitleHint');

const COLOR_HEX = {
  grey: '#9AA0A6',
  blue: '#4285F4',
  red: '#EA4335',
  yellow: '#FBBC04',
  green: '#34A853',
  pink: '#F6AEA9',
  purple: '#A142F4',
  cyan: '#24C1E0',
};

document.querySelector('.color-option[data-color="blue"]').classList.add('selected');

document.addEventListener('DOMContentLoaded', () => {
  checkWorkerBuild();
  loadSettings();
  populatePresets();
  setStatusFieldRows([{ selector: '', extract: '', label: '' }]);
  loadPatterns();
  prefillOriginFromActiveTab();
});

/**
 * Chrome keeps the old service worker running after files change on disk until the
 * extension is reloaded. Compare build numbers so the user is told instead of
 * hitting puzzling behaviour like unexpanded $1 templates.
 */
async function checkWorkerBuild() {
  const response = await sendMessage({ action: 'ping' });
  const workerBuild = response && response.build;
  if (workerBuild !== EXTENSION_BUILD) {
    console.warn(`Service worker build ${workerBuild} != popup build ${EXTENSION_BUILD}`);
    staleBanner.classList.remove('hidden');
  }
}

reloadExtensionBtn.addEventListener('click', () => {
  chrome.runtime.reload();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TITLE_HINT = '0 = no limit. Long names are shortened with "…"; the status is always kept.';

async function loadSettings() {
  const response = await sendMessage({ action: 'getSettings' });
  const value = response && response.settings ? Number(response.settings.maxTitleLength) : 0;
  maxTitleLength.value = Number.isFinite(value) && value > 0 ? value : 0;
}

maxTitleLength.addEventListener('change', async () => {
  let value = parseInt(maxTitleLength.value, 10);
  if (!Number.isFinite(value) || value < 0) value = 0;
  if (value > 0 && value < 12) value = 12; // anything shorter cannot hold a name and a status
  maxTitleLength.value = value;

  const response = await sendMessage({ action: 'saveSettings', settings: { maxTitleLength: value } });
  if (response && response.success) {
    const n = response.updatedGroups || 0;
    maxTitleHint.textContent = value
      ? `Saved. Titles limited to ${value} characters${n ? `, ${n} open group${n === 1 ? '' : 's'} re-titled` : ''}.`
      : `Saved. No limit${n ? `, ${n} open group${n === 1 ? '' : 's'} restored` : ''}.`;
    setTimeout(() => { maxTitleHint.textContent = DEFAULT_MAX_TITLE_HINT; }, 4000);
  } else {
    maxTitleHint.textContent = 'Could not save the setting. See the service worker console.';
  }
});

document.querySelectorAll('.color-option').forEach((option) => {
  option.addEventListener('click', () => {
    document.querySelectorAll('.color-option').forEach((opt) => opt.classList.remove('selected'));
    option.classList.add('selected');
    selectedColor = option.getAttribute('data-color');
  });
});

statusEnabled.addEventListener('change', () => {
  statusFields.classList.toggle('hidden', !statusEnabled.checked);
});

helpLink.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: HELP_URL });
});

// ---------------------------------------------------------------------------
// Status field rows
// ---------------------------------------------------------------------------

function addStatusFieldRow(field) {
  const index = statusFieldList.children.length + 1;
  const row = document.createElement('div');
  row.className = 'status-field-row';

  const head = document.createElement('div');
  head.className = 'row-head';
  const label = document.createElement('span');
  label.textContent = `Field ${index}`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    row.remove();
    if (!statusFieldList.children.length) addStatusFieldRow({ selector: '', extract: '', label: '' });
    renumberStatusFieldRows();
  });
  head.appendChild(label);
  head.appendChild(remove);

  const selector = document.createElement('input');
  selector.type = 'text';
  selector.className = 'sf-selector';
  selector.placeholder = 'CSS selector, e.g. [data-testid="ci-icon-text"]  (blank = Jira default)';
  selector.value = (field && field.selector) || '';

  const extra = document.createElement('div');
  extra.className = 'row-extra';
  const extract = document.createElement('input');
  extract.type = 'text';
  extract.className = 'sf-extract';
  extract.placeholder = 'Keep only (regex, optional) e.g. #\\d+\\s+(\\S+)';
  extract.value = (field && field.extract) || '';
  const fieldLabel = document.createElement('input');
  fieldLabel.type = 'text';
  fieldLabel.className = 'sf-label';
  fieldLabel.placeholder = 'Label (optional)';
  fieldLabel.value = (field && field.label) || '';
  extra.appendChild(extract);
  extra.appendChild(fieldLabel);

  row.appendChild(head);
  row.appendChild(selector);
  row.appendChild(extra);
  statusFieldList.appendChild(row);
}

function renumberStatusFieldRows() {
  Array.from(statusFieldList.children).forEach((row, i) => {
    row.querySelector('.row-head span').textContent = `Field ${i + 1}`;
  });
}

function setStatusFieldRows(fields) {
  statusFieldList.innerHTML = '';
  (fields && fields.length ? fields : [{ selector: '', extract: '', label: '' }]).forEach(addStatusFieldRow);
}

/** Reads the rows. Rows that are entirely blank are dropped, except the first. */
function readStatusFieldRows() {
  const rows = Array.from(statusFieldList.children).map((row) => ({
    selector: row.querySelector('.sf-selector').value.trim(),
    extract: row.querySelector('.sf-extract').value.trim(),
    label: row.querySelector('.sf-label').value.trim(),
  }));
  const kept = rows.filter((r, i) => i === 0 || r.selector || r.extract || r.label);
  return kept.map((r) => ({ ...r, selector: r.selector || DEFAULT_STATUS_SELECTOR }));
}

addStatusFieldBtn.addEventListener('click', () => addStatusFieldRow({ selector: '', extract: '', label: '' }));

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function populatePresets() {
  STATUS_PRESETS.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.verified ? preset.name : `${preset.name} (unverified)`;
    presetSelect.appendChild(option);
  });
}

presetSelect.addEventListener('change', () => {
  const preset = getPreset(presetSelect.value);
  presetHint.textContent = '';
  presetHint.classList.remove('warn-text');
  if (!preset) return;

  ruleName.value = preset.name;
  regexPattern.value = preset.regex;
  groupName.value = preset.groupName;
  statusEnabled.checked = true;
  statusFields.classList.remove('hidden');
  setStatusFieldRows(normalizeStatusFields(preset));
  if (!statusOrigin.value.trim()) prefillOriginFromActiveTab();

  let hint = `${preset.notes} Example group title: ${preset.exampleTitle}.`;
  if (!preset.verified) {
    hint += ' This selector has not been verified against the live product. Open a matching page and use "Test on Current Tab".';
    presetHint.classList.add('warn-text');
  }
  presetHint.textContent = hint;
  hideTestResult();
});

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

/** True when the regex has at least one capturing group: an unescaped "(" not followed by "?". */
function hasCaptureGroup(regex) {
  return /(^|[^\\])\((?!\?)/.test(regex || '');
}

/**
 * Validates the form and returns a pattern object, or null after alerting.
 * @param {boolean} forSave - when true, requires the group title.
 */
function readForm(forSave) {
  const regex = regexPattern.value.trim();
  const title = groupName.value.trim();
  const name = ruleName.value.trim() || title;

  if (!regex || (forSave && !title)) {
    alert('Please fill in the URL regex pattern and the tab group title.');
    return null;
  }

  try {
    new RegExp(regex);
  } catch (e) {
    alert('Invalid regex pattern. Please check your syntax.');
    return null;
  }

  if (/\$\d/.test(title) && !hasCaptureGroup(regex)) {
    alert('The tab group title uses $1 but the regex has no part in parentheses to insert. Add ( ) around the part you want, or use a plain title.');
    return null;
  }

  const fields = readStatusFieldRows();
  if (statusEnabled.checked) {
    for (let i = 0; i < fields.length; i++) {
      try {
        document.querySelector(fields[i].selector);
      } catch (e) {
        alert(`Status field ${i + 1}: invalid CSS selector.`);
        return null;
      }
      if (fields[i].extract) {
        try {
          new RegExp(fields[i].extract, 'i');
        } catch (e) {
          alert(`Status field ${i + 1}: invalid "Keep only" regex.`);
          return null;
        }
      }
    }
  }

  let origin = null;
  if (statusEnabled.checked && statusOrigin.value.trim()) {
    origin = normalizeOrigin(statusOrigin.value.trim());
    if (!origin) {
      alert('Site Origin must be an http(s) URL, e.g. https://yourcompany.atlassian.net');
      return null;
    }
  }

  return {
    id: currentPatternId || Date.now(),
    ruleName: name,
    regex,
    groupName: title,
    useCapture: false, // templates ($1) replace the legacy flag; background still honours it for old rules
    useRandomColor: useRandomColor.checked,
    color: selectedColor,
    active: true,
    statusEnabled: statusEnabled.checked,
    statusFields: fields,
    statusSelector: fields[0].selector, // kept for readability of stored data; statusFields is authoritative
    statusOrigin: origin,
  };
}

/**
 * Normalizes user input to an origin string, or null if it is not a valid http(s) URL.
 */
function normalizeOrigin(value) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch (e) {
    return null;
  }
}

function requestOriginPermission(origin) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
      if (chrome.runtime.lastError) {
        console.error('permissions.request failed', chrome.runtime.lastError);
        resolve(false);
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
  });
}

/** Promise wrapper that also surfaces runtime.lastError instead of leaving it unchecked. */
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`sendMessage(${message.action}) failed:`, chrome.runtime.lastError.message);
        resolve(undefined);
        return;
      }
      resolve(response);
    });
  });
}

async function prefillOriginFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) return;
  const origin = normalizeOrigin(tab.url);
  if (origin && !statusOrigin.value.trim()) statusOrigin.value = origin;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

addPatternBtn.addEventListener('click', async () => {
  const pattern = readForm(true);
  if (!pattern) return;

  // Must run inside the click handler so Chrome treats it as a user gesture.
  if (pattern.statusEnabled && pattern.statusOrigin) {
    const granted = await requestOriginPermission(pattern.statusOrigin);
    if (!granted) {
      alert(`Access to ${pattern.statusOrigin} was not granted. The rule will be saved, but status will not be read until access is allowed.`);
    }
  }

  const response = await sendMessage({ action: 'savePattern', pattern });
  if (response && response.success) {
    loadPatterns();
    resetForm();
  } else {
    console.error('Failed to save pattern:', response);
    alert('Failed to save rule. Please check console for details.');
  }
});

testRuleBtn.addEventListener('click', async () => {
  const pattern = readForm(false);
  if (!pattern) return;

  // Request access for the page we are about to test (user gesture required).
  if (pattern.statusEnabled) {
    const tab = await getActiveTab();
    const origin = tab && tab.url ? normalizeOrigin(tab.url) : null;
    if (origin) {
      if (!statusOrigin.value.trim()) statusOrigin.value = origin;
      await requestOriginPermission(origin);
    }
  }

  testRuleBtn.disabled = true;
  showTestResult('warn', [['Testing', 'reading the current tab...']]);
  try {
    const result = await sendMessage({ action: 'testRule', pattern });
    renderTestResult(result, pattern);
  } finally {
    testRuleBtn.disabled = false;
  }
});

applyToCurrentBtn.addEventListener('click', async () => {
  const response = await sendMessage({ action: 'applyToCurrentTab' });
  if (response && response.matched) {
    window.close();
    return;
  }
  if (regexPattern.value.trim()) {
    alert('No saved rule matches this tab.\n\nApply only runs rules that are already saved. Click "Add Rule" first, or use "Test on Current Tab" to try the form as it is.');
  } else {
    alert('No saved rule matches this tab.');
  }
});

// ---------------------------------------------------------------------------
// Test result rendering
// ---------------------------------------------------------------------------

function hideTestResult() {
  testResult.classList.add('hidden');
  testResult.textContent = '';
}

function showTestResult(level, rows) {
  testResult.className = `test-result ${level}`;
  testResult.textContent = '';
  rows.forEach(([label, value]) => {
    const row = document.createElement('p');
    row.className = 'row';
    const dt = document.createElement('dt');
    dt.textContent = `${label}: `;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    testResult.appendChild(row);
  });
}

function explainPart(part) {
  switch (part.error) {
    case 'invalid-selector':
      return 'invalid CSS selector.';
    case 'invalid-extract':
      return `invalid "Keep only" regex (read "${part.raw}" from ${part.element}).`;
    case 'extract-no-match':
      return `read "${part.raw}" from ${part.element}, but the "Keep only" regex did not match it.`;
    case 'extract-empty':
      return `read "${part.raw}" from ${part.element}, but the "Keep only" regex kept nothing. Check the parentheses.`;
    case 'empty-match':
      return `selector matched ${part.matchedCount} element(s) but none had any text. You probably selected a wrapper or an icon. Try the parent, or the inner element that holds the words.`;
    case 'no-match':
    default:
      return 'selector matched no element on this page within 3 seconds. Right-click the status on the page, choose Inspect, and copy a stable id or data-testid (see the explainer above).';
  }
}

function renderTestResult(result, pattern) {
  if (!result || result.ok === false) {
    const reason = result && result.reason;
    const messages = {
      'unsupported-page': 'The current tab is a browser page the extension cannot read. Open a normal web page.',
      'invalid-regex': `Invalid regex: ${result && result.detail}`,
    };
    showTestResult('err', [['Error', messages[reason] || 'Unexpected error. See the service worker console.']]);
    return;
  }

  const rows = [];
  let level = 'ok';

  if (result.match && !result.match.groupName) {
    level = 'warn';
    rows.push(['Regex', 'matches this tab']);
    rows.push(['Group title', 'empty. Fill in "Tab Group Title", e.g. $1 to use the part in parentheses.']);
  } else if (result.match) {
    rows.push(['Group title', result.match.groupName + (result.match.dynamic ? '' : ' (same for every matching tab)')]);
  } else {
    level = 'warn';
    rows.push(['Group title', 'the regex did not match this tab\'s URL or title']);
    rows.push(['URL', result.url]);
    rows.push(['Title', result.title || '(none)']);
  }

  if (pattern.statusEnabled) {
    if (result.statusReason === 'no-permission') {
      level = 'warn';
      rows.push(['Status', `access to ${result.origin || 'this site'} was not granted. Click Test again and allow access.`]);
    } else if (result.statusReason === 'error') {
      level = 'warn';
      rows.push(['Status', `reader failed: ${result.detail || 'unknown error'}`]);
    } else {
      const parts = result.parts || [];
      const multi = parts.length > 1;
      parts.forEach((part, i) => {
        const label = multi ? `Field ${i + 1}` : 'Status';
        if (part.value) {
          let text = part.value;
          if (part.raw && part.raw !== part.value) text += `  (kept from "${part.raw}")`;
          text += `  — read from ${part.element}`;
          rows.push([label, text]);
        } else {
          level = 'warn';
          rows.push([label, explainPart(part)]);
        }
      });
      if (result.status && result.finalTitle) {
        let label = 'Final title';
        if (result.maxTitleLength && result.finalTitle.includes('…')) label = `Final title (shortened to ${result.maxTitleLength})`;
        rows.push([label, result.finalTitle]);
      }
    }
  }

  showTestResult(level, rows);
}

// ---------------------------------------------------------------------------
// Rule list
// ---------------------------------------------------------------------------

async function loadPatterns() {
  const response = await sendMessage({ action: 'getPatterns' });
  renderPatterns((response && response.patterns) || []);
}

/** Human-readable description of how the group title is derived for a stored rule. */
function describeTitle(pattern) {
  if (/\$\d/.test(pattern.groupName)) return pattern.groupName;
  if (pattern.useCapture && hasCaptureGroup(pattern.regex)) return '$1 (first captured part)';
  return `${pattern.groupName} (fixed)`;
}

function renderPatterns(patterns) {
  if (patterns.length === 0) {
    patternList.innerHTML = '<div class="no-patterns">No rules added yet.</div>';
    return;
  }

  patternList.innerHTML = '';

  patterns.forEach((pattern) => {
    const item = document.createElement('div');
    item.className = 'pattern-item';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = pattern.active;
    toggle.title = 'Enable or disable this rule';
    toggle.addEventListener('change', () => togglePattern(pattern.id, toggle.checked));

    const info = document.createElement('div');
    info.className = 'pattern-info';

    const title = document.createElement('h3');
    title.textContent = pattern.ruleName || pattern.groupName;

    const colorIndicator = document.createElement('span');
    colorIndicator.style.display = 'inline-block';
    colorIndicator.style.width = '10px';
    colorIndicator.style.height = '10px';
    colorIndicator.style.borderRadius = '50%';
    colorIndicator.style.marginRight = '5px';
    colorIndicator.style.backgroundColor = COLOR_HEX[pattern.color] || COLOR_HEX.blue;
    title.prepend(colorIndicator);

    if (pattern.statusEnabled) {
      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.textContent = 'STATUS';
      title.appendChild(badge);
    }

    const details = document.createElement('p');
    details.textContent = `Group title: ${describeTitle(pattern)}  ·  Pattern: ${pattern.regex}`;

    info.appendChild(title);
    info.appendChild(details);

    if (pattern.statusEnabled) {
      const statusLine = document.createElement('p');
      statusLine.textContent = `Status from: ${describeStatusFields(pattern)}`;
      if (pattern.statusOrigin) statusLine.textContent += ` on ${pattern.statusOrigin}`;
      info.appendChild(statusLine);
    }

    const actions = document.createElement('div');
    actions.className = 'pattern-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editPattern(pattern));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deletePattern(pattern.id));

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(toggle);
    item.appendChild(info);
    item.appendChild(actions);

    patternList.appendChild(item);
  });
}

function editPattern(pattern) {
  currentPatternId = pattern.id;
  presetSelect.value = '';
  presetHint.textContent = '';
  ruleName.value = pattern.ruleName || pattern.groupName;
  regexPattern.value = pattern.regex;

  // Legacy rules used a checkbox to mean "first capture group". Show that as $1
  // so the user sees exactly what the rule does; saving converts it to a template.
  if (!/\$\d/.test(pattern.groupName) && pattern.useCapture && hasCaptureGroup(pattern.regex)) {
    groupName.value = '$1';
  } else {
    groupName.value = pattern.groupName;
  }

  useRandomColor.checked = pattern.useRandomColor || false;

  statusEnabled.checked = Boolean(pattern.statusEnabled);
  statusFields.classList.toggle('hidden', !statusEnabled.checked);
  setStatusFieldRows(pattern.statusEnabled || pattern.statusFields || pattern.statusSelector
    ? normalizeStatusFields(pattern)
    : [{ selector: '', extract: '', label: '' }]);
  statusOrigin.value = pattern.statusOrigin || '';

  document.querySelectorAll('.color-option').forEach((opt) => opt.classList.remove('selected'));
  const colorEl = document.querySelector(`.color-option[data-color="${pattern.color}"]`)
    || document.querySelector('.color-option[data-color="blue"]');
  colorEl.classList.add('selected');
  selectedColor = colorEl.getAttribute('data-color');

  addPatternBtn.textContent = 'Update Rule';
  hideTestResult();
}

async function deletePattern(id) {
  if (!confirm('Are you sure you want to delete this rule?')) return;
  const response = await sendMessage({ action: 'deletePattern', id });
  if (response && response.success) {
    loadPatterns();
    if (currentPatternId === id) resetForm();
  }
}

async function togglePattern(id, active) {
  const response = await sendMessage({ action: 'getPatterns' });
  const patterns = (response && response.patterns) || [];
  const index = patterns.findIndex((p) => p.id === id);
  if (index === -1) return;
  patterns[index].active = active;
  const saved = await sendMessage({ action: 'savePattern', pattern: patterns[index] });
  if (saved && saved.success) loadPatterns();
}

function resetForm() {
  currentPatternId = null;
  presetSelect.value = '';
  presetHint.textContent = '';
  presetHint.classList.remove('warn-text');
  ruleName.value = '';
  regexPattern.value = '';
  groupName.value = '';
  useRandomColor.checked = false;
  statusEnabled.checked = false;
  statusFields.classList.add('hidden');
  setStatusFieldRows([{ selector: '', extract: '', label: '' }]);
  statusOrigin.value = '';
  prefillOriginFromActiveTab();
  selectedColor = 'blue';
  document.querySelectorAll('.color-option').forEach((opt) => opt.classList.remove('selected'));
  document.querySelector('.color-option[data-color="blue"]').classList.add('selected');
  addPatternBtn.textContent = 'Add Rule';
  hideTestResult();
}
