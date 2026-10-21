/**
 * TabStar Status - background service worker.
 *
 * Responsibilities:
 *  1. Match tab URL / title against user-defined regex rules and put the tab in a
 *     group whose title comes from a $1/$2 template (or, for legacy rules, the first
 *     capture group or a fixed name).
 *  2. For rules with status tracking enabled, inject a small reader into the page,
 *     pull a status string out of the DOM and append it to the group title:
 *        "ABC-123"  ->  "ABC-123 - In Progress"
 *  3. Keep a registry (base name -> group id) so that a renamed group is still
 *     recognised when another matching tab opens or the page is refreshed.
 */

importScripts('presets.js'); // EXTENSION_BUILD, DEFAULT_STATUS_SELECTOR, STATUS_JOINER, STATUS_PRESETS, normalizeStatusFields

const availableColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

/** Separator between the base group name and the status suffix. */
const STATUS_SEPARATOR = ' - ';

/** How long the injected reader waits for the status element to appear (SPA pages render late). */
const STATUS_WAIT_MS = 10000;

/** Shorter wait for the popup's "Test on Current Tab" dry run. */
const TEST_WAIT_MS = 3000;

/** Marker used when a base name is shortened to respect settings.maxTitleLength. */
const TITLE_ELLIPSIS = '…';

/**
 * Never shorten the base name below this many characters, even if the title then
 * exceeds the limit. 8 keeps typical ticket keys (ABC-123, INC0010042) intact.
 */
const MIN_BASE_CHARS = 8;

/** Hard cap on a status string, so a wrong selector cannot dump a paragraph into the title. */
const MAX_STATUS_CHARS = 80;

const DEFAULT_SETTINGS = {
  /** 0 = no limit. Chrome renders group titles on one line and truncates long ones itself. */
  maxTitleLength: 0,
};

let regexPatterns = [];
let settings = { ...DEFAULT_SETTINGS };

/** Resolve once patterns / settings are loaded from storage. All handlers await these. */
const patternsReady = loadPatterns();
const settingsReady = loadSettings();

function getRandomColor() {
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

/** Compiled-regex cache keyed by source; invalid sources throw and are not cached. */
const regexCache = new Map();
function compileRegex(source) {
  let re = regexCache.get(source);
  if (!re) {
    re = new RegExp(source);
    regexCache.set(source, re);
  }
  return re;
}

/**
 * Serialises every read-modify-write of the registry (and the group lookups that
 * depend on it). Without this, two tabs for the same ticket finishing at once both
 * see "no group yet" and create duplicates.
 */
let registryLock = Promise.resolve();
function withRegistryLock(fn) {
  const run = registryLock.then(fn, fn);
  registryLock = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Pattern persistence
// ---------------------------------------------------------------------------

async function loadPatterns() {
  const result = await chrome.storage.local.get(['regexPatterns']);
  regexPatterns = Array.isArray(result.regexPatterns) ? result.regexPatterns : [];
  console.log('Loaded patterns from storage:', regexPatterns);
}

async function savePatterns() {
  regexCache.clear();
  await chrome.storage.local.set({ regexPatterns });
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['settings']);
  settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

async function saveSettings(next) {
  const max = Number(next && next.maxTitleLength);
  settings = {
    ...settings,
    maxTitleLength: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
  };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ---------------------------------------------------------------------------
// Group registry (session-scoped: group ids do not survive a browser restart)
//
// Shape: { "<windowId>:<baseName>": { groupId: number, status: string|null } }
// ---------------------------------------------------------------------------

function registryKey(windowId, baseName) {
  return `${windowId}:${baseName}`;
}

function baseNameFromKey(key) {
  return key.slice(key.indexOf(':') + 1);
}

async function getRegistry() {
  const result = await chrome.storage.session.get(['groupRegistry']);
  return result.groupRegistry || {};
}

async function setRegistry(groupRegistry) {
  await chrome.storage.session.set({ groupRegistry });
}

async function safeGetGroup(groupId) {
  try {
    return await chrome.tabGroups.get(groupId);
  } catch (e) {
    return null;
  }
}

/**
 * Builds the group title from a base name and optional status, honouring
 * settings.maxTitleLength. Only the base name is ever shortened (with an
 * ellipsis); the status suffix is always kept intact so it stays readable when
 * the tab strip is crowded. The base is never cut below MIN_BASE_CHARS, so with
 * a very long status the title may still exceed the limit; identity wins.
 */
function buildTitle(baseName, status, maxLength = settings.maxTitleLength) {
  const suffix = status ? `${STATUS_SEPARATOR}${status}` : '';
  const full = baseName + suffix;
  if (!maxLength || maxLength <= 0 || full.length <= maxLength) return full;

  const budget = Math.max(MIN_BASE_CHARS, maxLength - suffix.length - TITLE_ELLIPSIS.length);
  if (baseName.length <= budget) return full;
  return baseName.slice(0, budget).trimEnd() + TITLE_ELLIPSIS + suffix;
}

/**
 * True when an existing group title was produced from baseName. Used only as a
 * fallback when the registry has no entry for the group. Exact match always
 * counts (upstream behaviour); the " - status" and shortened "head…" forms are
 * only accepted when this rule can actually produce them, so a fixed-title rule
 * named "GitHub" does not adopt a hand-made "GitHub - Docs" group.
 */
function titleMatchesBase(title, baseName, { allowStatus = false, allowShortened = false } = {}) {
  if (!title) return false;
  if (title === baseName) return true;
  if (allowStatus && title.startsWith(baseName + STATUS_SEPARATOR)) return true;
  if (!allowShortened) return false;

  const cut = title.indexOf(TITLE_ELLIPSIS);
  if (cut < 3) return false; // buildTitle never produces heads this short
  const head = title.slice(0, cut);
  const rest = title.slice(cut + TITLE_ELLIPSIS.length);
  if (!baseName.startsWith(head)) return false;
  return rest === '' || (allowStatus && rest.startsWith(STATUS_SEPARATOR));
}

/** Collapses whitespace and caps length so a bad selector cannot flood the title. */
function normalizeStatus(status) {
  if (!status) return null;
  const text = String(status).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_STATUS_CHARS ? `${text.slice(0, MAX_STATUS_CHARS - 1).trimEnd()}${TITLE_ELLIPSIS}` : text;
}

/** Extracts the status suffix from an existing title (full or shortened), or null if there is none. */
function parseStatus(title, baseName) {
  if (!title) return null;
  const prefix = baseName + STATUS_SEPARATOR;
  if (title.startsWith(prefix)) return title.slice(prefix.length);

  const cut = title.indexOf(TITLE_ELLIPSIS);
  if (cut >= 0) {
    const rest = title.slice(cut + TITLE_ELLIPSIS.length);
    if (rest.startsWith(STATUS_SEPARATOR)) return rest.slice(STATUS_SEPARATOR.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const TEMPLATE_TOKEN = /\$(\d)/g;

function hasTemplate(groupName) {
  return /\$\d/.test(groupName || '');
}

/** Replaces $1..$9 in the template with the corresponding capture groups. */
function expandTemplate(template, match) {
  return template.replace(TEMPLATE_TOKEN, (_, n) => match[Number(n)] || '').replace(/\s+/g, ' ').trim();
}

/**
 * Tests one pattern against one subject string.
 *
 * Group title resolution, in order:
 *   1. groupName contains $N tokens   -> expand the template with capture groups
 *   2. legacy useCapture + a capture  -> the first capture group
 *   3. otherwise                      -> groupName verbatim
 *
 * @returns {{pattern: object, groupName: string, color: string, dynamic: boolean}|null}
 */
function resolveMatch(pattern, subject) {
  const match = subject.match(compileRegex(pattern.regex));
  if (!match) return null;

  const templated = hasTemplate(pattern.groupName);
  const usedCapture = Boolean(pattern.useCapture && match.length > 1 && match[1]);

  let groupName;
  if (templated) {
    groupName = expandTemplate(pattern.groupName, match) || pattern.ruleName || pattern.groupName;
  } else if (usedCapture) {
    groupName = match[1];
  } else {
    groupName = pattern.groupName;
  }

  const dynamic = templated || usedCapture;
  const color = pattern.useRandomColor && dynamic ? getRandomColor() : pattern.color;

  return { pattern, groupName, color, dynamic };
}

/**
 * Finds the first active pattern matching the URL, then the title.
 */
function findMatch(url, title, patterns = regexPatterns) {
  for (const subject of [url, title]) {
    if (!subject) continue;
    for (const pattern of patterns) {
      if (!pattern.active) continue;
      try {
        const result = resolveMatch(pattern, subject);
        if (result) return result;
      } catch (e) {
        console.error(`Invalid regex pattern: ${pattern.regex}`, e);
      }
    }
  }
  return null;
}

function isIgnoredUrl(url) {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Puts the tab into the group identified by baseName in its window, creating the
 * group if needed. Uses the registry first, then falls back to scanning titles
 * (covers service-worker restarts and groups created before the registry existed).
 * Runs under the registry lock so concurrent loads cannot create duplicates.
 * @returns {Promise<number>} the group id
 */
function ensureGroup(tab, baseName, color, { allowStatus = false } = {}) {
  return withRegistryLock(async () => {
    const key = registryKey(tab.windowId, baseName);
    const registry = await getRegistry();

    let entry = registry[key];
    let group = entry ? await safeGetGroup(entry.groupId) : null;

    if (!group) {
      const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
      const tolerance = { allowStatus, allowShortened: settings.maxTitleLength > 0 };
      group = groups.find((g) => titleMatchesBase(g.title, baseName, tolerance)) || null;
      entry = group ? { groupId: group.id, status: allowStatus ? parseStatus(group.title, baseName) : null } : null;
    }

    if (!group) {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: buildTitle(baseName, null), color });
      entry = { groupId, status: null };
    } else if (tab.groupId !== group.id) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
    }

    registry[key] = entry;
    await setRegistry(registry);
    return entry.groupId;
  });
}

/**
 * Renames the group to "<base> - <status>" (or just "<base>" when status is null)
 * and records the status in the registry. No-op for groups we did not create.
 * When expectedKey is given, the group must be registered under that key; this
 * stops a tab that was dragged into another ticket's group from renaming it.
 */
function applyStatus(groupId, status, expectedKey = null) {
  return withRegistryLock(async () => {
    const registry = await getRegistry();
    const key = Object.keys(registry).find((k) => registry[k].groupId === groupId);
    if (!key) {
      console.warn('applyStatus: group not in registry', groupId);
      return false;
    }
    if (expectedKey && key !== expectedKey) {
      console.warn(`applyStatus: group ${groupId} belongs to "${baseNameFromKey(key)}", not "${baseNameFromKey(expectedKey)}"; ignoring`);
      return false;
    }

    const normalized = normalizeStatus(status);
    if (registry[key].status === normalized) return true;

    const group = await safeGetGroup(groupId);
    if (!group) {
      delete registry[key];
      await setRegistry(registry);
      return false;
    }

    registry[key].status = normalized;
    await setRegistry(registry);
    await chrome.tabGroups.update(groupId, { title: buildTitle(baseNameFromKey(key), normalized) });
    console.log(`Group ${groupId} status -> ${normalized}`);
    return true;
  });
}

/**
 * Re-applies titles to every group in the registry. Called when the title
 * length setting changes so existing groups pick up the new limit.
 */
function refreshAllTitles() {
  return withRegistryLock(async () => {
    const registry = await getRegistry();
    let updated = 0;
    for (const key of Object.keys(registry)) {
      const group = await safeGetGroup(registry[key].groupId);
      if (!group) continue;
      const title = buildTitle(baseNameFromKey(key), registry[key].status);
      if (group.title !== title) {
        await chrome.tabGroups.update(group.id, { title });
        updated++;
      }
    }
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Status extraction
// ---------------------------------------------------------------------------

/**
 * Runs inside the target page (isolated world). Must be self-contained: no
 * references to anything outside this function.
 *
 * `fields` is a list of { selector, extract, label }. For each field the first
 * element matching `selector` that has text (or a value, for inputs/selects) is
 * read; `extract` (a regex) optionally narrows the text to its first capture
 * group; `label` is prefixed. Values are joined with `joiner`.
 *
 * Waits up to `timeoutMs` for every field to produce a value, then resolves with
 * whatever was found (fields that never appear are simply omitted). When `observe`
 * is true it also installs a MutationObserver (once per document) that reports
 * later changes to the service worker.
 *
 * Resolves to { status, parts } where parts[i] describes field i:
 *   { value, raw, element, matchedCount, error }
 *   error is null or one of: invalid-selector, invalid-extract, extract-no-match,
 *   extract-empty, empty-match, no-match
 */
function readStatusFromPage(fields, timeoutMs, observe, joiner) {
  const textOf = (el) => {
    if (!el) return '';
    let text;
    switch (el.tagName) {
      case 'SELECT': {
        const opt = el.selectedOptions && el.selectedOptions[0];
        text = opt ? opt.textContent : el.value;
        break;
      }
      case 'INPUT':
      case 'TEXTAREA':
        text = el.value;
        break;
      default:
        text = el.textContent;
    }
    return (text || '').replace(/\s+/g, ' ').trim();
  };

  const describeOne = (el) => {
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) desc += `[data-testid="${testId}"]`;
    else if (el.getAttribute('aria-label')) desc += `[aria-label="${el.getAttribute('aria-label')}"]`;
    else if (el.classList.length) desc += `.${Array.from(el.classList).slice(0, 2).join('.')}`;
    return desc.length > 70 ? `${desc.slice(0, 67)}...` : desc;
  };

  /** Element plus up to two identifiable ancestors, so the user can see *where* on the page it sits. */
  const describe = (el) => {
    const path = [describeOne(el)];
    let node = el.parentElement;
    let hops = 0;
    while (node && node !== document.body && path.length < 3 && hops < 8) {
      const identifiable =
        node.id || node.getAttribute('data-testid') || node.getAttribute('data-test-id') ||
        node.getAttribute('aria-label') || node.classList.length;
      if (identifiable) path.push(describeOne(node));
      node = node.parentElement;
      hops++;
    }
    return path.length > 1 ? `${path[0]} (inside ${path.slice(1).join(' › ')})` : path[0];
  };

  /**
   * Splits a selector list on top-level commas only, so ":is(a, b)" and
   * attribute values containing commas stay intact. Alternatives are tried in
   * the order written, which querySelectorAll("a, b") would NOT do (it returns
   * page order).
   */
  const splitSelectorList = (selector) => {
    const out = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (const ch of selector) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '(' || ch === '[') {
        depth++;
        current += ch;
      } else if (ch === ')' || ch === ']') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };

  const readField = (field) => {
    const alternatives = splitSelectorList(field.selector);
    let matchedCount = 0;
    let validAlternatives = 0;

    for (const alt of alternatives) {
      let nodes;
      try {
        nodes = document.querySelectorAll(alt);
      } catch (e) {
        continue; // skip an invalid alternative, keep trying the rest
      }
      validAlternatives++;
      matchedCount += nodes.length;

      for (const el of nodes) {
        const raw = textOf(el);
        if (!raw) continue;
        let value = raw;
        if (field.extract) {
          let m;
          try {
            m = raw.match(new RegExp(field.extract, 'i'));
          } catch (e) {
            return { value: null, raw, element: describe(el), matchedCount, error: 'invalid-extract' };
          }
          if (!m) return { value: null, raw, element: describe(el), matchedCount, error: 'extract-no-match' };
          value = (m[1] !== undefined ? m[1] : m[0]).replace(/\s+/g, ' ').trim();
          if (!value) return { value: null, raw, element: describe(el), matchedCount, error: 'extract-empty' };
        }
        if (field.label) value = `${field.label} ${value}`;
        return { value, raw, element: describe(el), matchedCount, error: null };
      }
    }

    if (!validAlternatives) return { value: null, raw: null, element: null, matchedCount: 0, error: 'invalid-selector' };
    return { value: null, raw: null, element: null, matchedCount, error: matchedCount ? 'empty-match' : 'no-match' };
  };

  const read = () => {
    const parts = fields.map(readField);
    const values = parts.map((p) => p.value).filter(Boolean);
    return {
      status: values.length ? values.join(joiner) : null,
      parts,
      complete: values.length === fields.length,
    };
  };

  const notify = (status) => {
    try {
      chrome.runtime.sendMessage({ action: 'statusObserved', status }).catch(() => {});
    } catch (e) {
      /* extension reloaded; ignore */
    }
  };

  const installObserver = (initial) => {
    if (!observe) return;
    if (window.__tabStarStatusObserver) {
      window.__tabStarStatusLast = initial;
      return;
    }
    window.__tabStarStatusLast = initial;
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = read().status;
        if (now && now !== window.__tabStarStatusLast) {
          window.__tabStarStatusLast = now;
          notify(now);
        }
      }, 250);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['value'],
    });
    window.__tabStarStatusObserver = observer;
  };

  return new Promise((resolve) => {
    const initial = read();
    if (initial.complete) {
      installObserver(initial.status);
      resolve({ status: initial.status, parts: initial.parts });
      return;
    }

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      waiter.disconnect();
      clearTimeout(timeout);
      if (value.status) installObserver(value.status);
      resolve({ status: value.status, parts: value.parts });
    };

    const waiter = new MutationObserver(() => {
      const value = read();
      if (value.complete) finish(value);
    });
    waiter.observe(document.documentElement, { childList: true, subtree: true });

    const timeout = setTimeout(() => finish(read()), timeoutMs);
  });
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch (e) {
    return null;
  }
}

async function hasHostPermission(url) {
  const origin = originOf(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch (e) {
    return false;
  }
}

/**
 * Injects the reader into every frame of the tab. Returns the frame result with
 * the most field values; on a total miss, returns the frame whose parts matched
 * the most elements so the popup can explain what went wrong.
 */
async function runReader(tabId, fields, timeoutMs, observe) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: readStatusFromPage,
    args: [fields, timeoutMs, observe, STATUS_JOINER],
  });
  const frames = (results || []).map((r) => r && r.result).filter((r) => r && Array.isArray(r.parts));
  if (!frames.length) {
    return { status: null, parts: fields.map(() => ({ value: null, element: null, matchedCount: 0, error: 'no-match' })) };
  }
  const score = (r) => r.parts.filter((p) => p.value).length * 1000 + r.parts.reduce((n, p) => n + (p.matchedCount || 0), 0);
  frames.sort((a, b) => score(b) - score(a));
  return frames[0];
}

async function extractStatus(tab, pattern) {
  if (!(await hasHostPermission(tab.url))) {
    console.warn(`No host permission for ${tab.url}; skipping status read. Grant it from the popup.`);
    return null;
  }
  try {
    const result = await runReader(tab.id, normalizeStatusFields(pattern), STATUS_WAIT_MS, true);
    return result.status;
  } catch (e) {
    console.error('Status extraction failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Groups the tab if a rule matches and, when the rule tracks status, reads and
 * applies it. Returns true when a rule matched.
 */
async function processTab(tab) {
  await Promise.all([patternsReady, settingsReady]);
  if (!tab || !tab.url || isIgnoredUrl(tab.url)) return false;

  const match = findMatch(tab.url, tab.title);
  if (!match) return false;

  const statusEnabled = Boolean(match.pattern.statusEnabled);
  const groupId = await ensureGroup(tab, match.groupName, match.color, { allowStatus: statusEnabled });

  if (statusEnabled) {
    const status = await extractStatus(tab, match.pattern);
    if (status) await applyStatus(groupId, status, registryKey(tab.windowId, match.groupName));
  }
  return true;
}

/**
 * Dry run used by the popup: evaluates an unsaved rule against the active tab
 * without grouping it. Reports the resolved group title and, per status field,
 * what the selector found.
 */
async function testRule(draft) {
  await settingsReady;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || isIgnoredUrl(tab.url)) {
    return { ok: false, reason: 'unsupported-page' };
  }

  const result = {
    ok: true,
    url: tab.url,
    title: tab.title,
    match: null,
    status: null,
    parts: [],
    statusReason: null,
    finalTitle: null,
    maxTitleLength: settings.maxTitleLength,
  };

  try {
    new RegExp(draft.regex);
  } catch (e) {
    return { ok: false, reason: 'invalid-regex', detail: e.message };
  }

  const match = findMatch(tab.url, tab.title, [{ ...draft, active: true }]);
  if (match) result.match = { groupName: match.groupName, dynamic: match.dynamic };

  if (draft.statusEnabled) {
    if (!(await hasHostPermission(tab.url))) {
      result.statusReason = 'no-permission';
      result.origin = originOf(tab.url);
    } else {
      try {
        const read = await runReader(tab.id, normalizeStatusFields(draft), TEST_WAIT_MS, false);
        result.status = read.status;
        result.parts = read.parts;
        if (!read.status) result.statusReason = 'no-status';
      } catch (e) {
        result.statusReason = 'error';
        result.detail = e && e.message;
      }
    }
  }

  if (result.match && result.match.groupName) {
    result.finalTitle = buildTitle(result.match.groupName, normalizeStatus(result.status));
  }
  return result;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Full loads report status:'complete'. Single-page apps (Jira Cloud, GitLab)
  // change the URL without reloading, in which case only `url` is set and the tab
  // is already complete; handle both so the tab moves to the right group.
  const loaded = changeInfo.status === 'complete';
  const spaNavigation = Boolean(changeInfo.url) && tab.status === 'complete';
  if (!loaded && !spaNavigation) return;
  processTab(tab).catch((e) => console.error('processTab failed', e));
});

chrome.tabGroups.onRemoved.addListener((group) => {
  withRegistryLock(async () => {
    const registry = await getRegistry();
    let changed = false;
    for (const key of Object.keys(registry)) {
      if (registry[key].groupId === group.id) {
        delete registry[key];
        changed = true;
      }
    }
    if (changed) await setRegistry(registry);
  }).catch((e) => console.error('registry cleanup failed', e));
});

// ---------------------------------------------------------------------------
// Messaging (popup + injected reader)
// ---------------------------------------------------------------------------

async function handleMessage(request, sender) {
  await Promise.all([patternsReady, settingsReady]);

  switch (request.action) {
    case 'ping':
      return { build: EXTENSION_BUILD };

    case 'getPatterns':
      return { patterns: regexPatterns };

    case 'getPresets':
      return { presets: STATUS_PRESETS, defaultSelector: DEFAULT_STATUS_SELECTOR };

    case 'getSettings':
      return { settings };

    case 'saveSettings': {
      const saved = await saveSettings(request.settings);
      const updated = await refreshAllTitles();
      return { success: true, settings: saved, updatedGroups: updated };
    }

    case 'savePattern': {
      const pattern = request.pattern;
      const index = regexPatterns.findIndex((p) => p.id === pattern.id);
      if (index !== -1) {
        regexPatterns[index] = pattern;
      } else {
        pattern.id = pattern.id || Date.now();
        regexPatterns.push(pattern);
      }
      await savePatterns();
      return { success: true };
    }

    case 'deletePattern': {
      const index = regexPatterns.findIndex((p) => p.id === request.id);
      if (index === -1) return { success: false };
      regexPatterns.splice(index, 1);
      await savePatterns();
      return { success: true };
    }

    case 'applyToCurrentTab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const matched = await processTab(tab);
      return { matched };
    }

    case 'testRule':
      return testRule(request.pattern || {});

    case 'statusObserved': {
      // Only trust messages that come from a tab we grouped under a status-tracking rule.
      const tab = sender.tab;
      if (!tab || tab.groupId === undefined || tab.groupId < 0) return { success: false };
      const match = findMatch(tab.url, tab.title);
      if (!match || !match.pattern.statusEnabled) return { success: false };
      const success = await applyStatus(tab.groupId, request.status, registryKey(tab.windowId, match.groupName));
      return { success };
    }

    default:
      return { success: false, error: `Unknown action: ${request.action}` };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((e) => {
      console.error('Message handling failed', request, e);
      sendResponse({ success: false, error: e && e.message });
    });
  return true; // keep the channel open for the async response
});
