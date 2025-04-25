let regexPatterns = [];

const availableColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

/**
 * Returns a randomly selected color from the available colors
 * @returns {string} A color name
 */
function getRandomColor() {
  const randomIndex = Math.floor(Math.random() * availableColors.length);
  return availableColors[randomIndex];
}

/**
 * Initializes regex patterns from browser storage
 */
function initializeStorage() {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['regexPatterns'], (result) => {
      if (result && result.regexPatterns) {
        regexPatterns = result.regexPatterns;
        console.log('Loaded patterns from storage:', regexPatterns);
      } else {
        console.log('No patterns found in storage');
      }
    });
  } else {
    console.error('chrome.storage.local is not available');
  }
}

initializeStorage();

/**
 * Saves regex patterns to browser storage
 */
function savePatterns() {
  if (chrome.storage && chrome.storage.local) {
    console.log('Saving patterns to storage:', regexPatterns);
    chrome.storage.local.set({ regexPatterns }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error saving patterns:', chrome.runtime.lastError);
      } else {
        console.log('Patterns saved successfully');
      }
    });
  } else {
    console.error('Failed to save patterns: chrome.storage.local is not available');
  }
}

/**
 * Checks if a URL or title matches any of the regex patterns
 * @param {string} url - The URL to check against patterns
 * @param {string} title - The tab title to check against patterns
 * @param {number} tabId - The ID of the tab to potentially group
 * @returns {boolean} True if a match was found and tab was grouped
 */
function checkForMatch(url, title, tabId) {
  for (const pattern of regexPatterns) {
    if (!pattern.active) continue;
    
    try {
      const regex = new RegExp(pattern.regex);
      const match = url.match(regex);
      
      if (match) {
        let groupName = pattern.groupName;
        
        if (match.length > 1 && pattern.useCapture) {
          groupName = match[1]; // Use the first capture group
        }
        
        let color = pattern.color;
        
        if (pattern.useRandomColor && pattern.useCapture && match.length > 1) {
          color = getRandomColor();
        }
        
        groupTab(tabId, groupName, color);
        return true;
      }
    } catch (e) {
      console.error(`Invalid regex pattern: ${pattern.regex}`, e);
    }
  }
  
  if (title) {
    for (const pattern of regexPatterns) {
      if (!pattern.active) continue;
      
      try {
        const regex = new RegExp(pattern.regex);
        const match = title.match(regex);
        
        if (match) {
          let groupName = pattern.groupName;
          
          if (match.length > 1 && pattern.useCapture) {
            groupName = match[1]; // Use the first capture group
          }
          
          let color = pattern.color;
          
          if (pattern.useRandomColor && pattern.useCapture && match.length > 1) {
            color = getRandomColor();
          }
          
          groupTab(tabId, groupName, color);
          return true;
        }
      } catch (e) {
        console.error(`Invalid regex pattern when matching title: ${pattern.regex}`, e);
      }
    }
  }
  
  return false;
}

/**
 * Groups a tab with the specified name and color
 * @param {number} tabId - The ID of the tab to group
 * @param {string} groupName - The name to give to the tab group
 * @param {string} color - The color to assign to the tab group
 */
async function groupTab(tabId, groupName, color) {
  const tab = await chrome.tabs.get(tabId);
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  
  let groupId = null;
  
  for (const group of groups) {
    if (group.title === groupName) {
      groupId = group.id;
      break;
    }
  }
  
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { 
      title: groupName,
      color: color 
    });
  } else {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  }
}

/**
 * Listen for tab updates to apply grouping based on regex patterns
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Don't process chrome:// urls or extension pages
    if (!tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      checkForMatch(tab.url, tab.title, tabId);
    }
  }
});

/**
 * Handle messages from the popup for pattern management
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPatterns') {
    sendResponse({ patterns: regexPatterns });
  } else if (request.action === 'savePattern') {
    const pattern = request.pattern;
    const index = regexPatterns.findIndex(p => p.id === pattern.id);
    
    if (index !== -1) {
      regexPatterns[index] = pattern;
    } else {
      pattern.id = Date.now(); // Create a unique id
      regexPatterns.push(pattern);
    }
    
    savePatterns();
    sendResponse({ success: true });
  } else if (request.action === 'deletePattern') {
    const index = regexPatterns.findIndex(p => p.id === request.id);
    if (index !== -1) {
      regexPatterns.splice(index, 1);
      savePatterns();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
  } else if (request.action === 'applyToCurrentTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url) {
        const matched = checkForMatch(tabs[0].url, tabs[0].title, tabs[0].id);
        sendResponse({ matched });
      } else {
        sendResponse({ matched: false });
      }
    });
    return true; // This keeps the message channel open for the async response
  }
});
