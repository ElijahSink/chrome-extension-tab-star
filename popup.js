let currentPatternId = null;
let selectedColor = 'blue';

const patternList = document.getElementById('patternList');
const regexPattern = document.getElementById('regexPattern');
const groupName = document.getElementById('groupName');
const useCapture = document.getElementById('useCapture');
const useRandomColor = document.getElementById('useRandomColor');
const addPatternBtn = document.getElementById('addPattern');
const applyToCurrentBtn = document.getElementById('applyToCurrent');

document.querySelector(`.color-option[data-color="blue"]`).classList.add('selected');

document.addEventListener('DOMContentLoaded', () => {
  loadPatterns();
});

document.querySelectorAll('.color-option').forEach(option => {
  option.addEventListener('click', () => {
    document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
    option.classList.add('selected');
    selectedColor = option.getAttribute('data-color');
  });
});

addPatternBtn.addEventListener('click', () => {
  console.log('Add Pattern button clicked');
  const regex = regexPattern.value.trim();
  const name = groupName.value.trim();
  
  if (!regex || !name) {
    alert('Please fill in both the regex pattern and group name fields.');
    console.error('Validation failed: Empty regex or name field');
    return;
  }
  
  try {
    new RegExp(regex);
    console.log('Regex validation passed:', regex);
  } catch (e) {
    alert('Invalid regex pattern. Please check your syntax.');
    console.error('Regex validation failed:', e.message);
    return;
  }
  
  const pattern = {
    id: currentPatternId || Date.now(),
    regex: regex,
    groupName: name,
    useCapture: useCapture.checked,
    useRandomColor: useRandomColor.checked,
    color: selectedColor,
    active: true
  };
  
  console.log('Sending savePattern message with pattern:', pattern);
  
  chrome.runtime.sendMessage(
    { action: 'savePattern', pattern: pattern },
    response => {
      console.log('savePattern response received:', response);
      if (response && response.success) {
        console.log('Pattern saved successfully');
        loadPatterns();
        resetForm();
      } else {
        console.error('Failed to save pattern:', response);
        alert('Failed to save pattern. Please check console for details.');
      }
    }
  );
});

applyToCurrentBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { action: 'applyToCurrentTab' },
    response => {
      if (response.matched) {
        window.close(); // Close popup if successful
      } else {
        alert('No matching patterns for the current tab.');
      }
    }
  );
});

/**
 * Loads regex patterns from background script storage
 */
function loadPatterns() {
  chrome.runtime.sendMessage({ action: 'getPatterns' }, response => {
    renderPatterns(response.patterns || []);
  });
}

/**
 * Renders the list of patterns in the popup UI
 * @param {Array} patterns - Array of regex pattern objects
 */
function renderPatterns(patterns) {
  if (patterns.length === 0) {
    patternList.innerHTML = '<div class="no-patterns">No patterns added yet.</div>';
    return;
  }
  
  patternList.innerHTML = '';
  
  patterns.forEach(pattern => {
    const item = document.createElement('div');
    item.className = 'pattern-item';
    
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = pattern.active;
    toggle.addEventListener('change', () => togglePattern(pattern.id, toggle.checked));
    
    const info = document.createElement('div');
    info.className = 'pattern-info';
    
    const title = document.createElement('h3');
    title.textContent = pattern.groupName;
    
    const details = document.createElement('p');
    details.textContent = `Pattern: ${pattern.regex}`;
    if (pattern.useCapture) {
      details.textContent += ' (Using capture group)';
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
    
    const colorIndicator = document.createElement('span');
    colorIndicator.style.display = 'inline-block';
    colorIndicator.style.width = '10px';
    colorIndicator.style.height = '10px';
    colorIndicator.style.borderRadius = '50%';
    colorIndicator.style.marginRight = '5px';
    
    switch (pattern.color) {
      case 'grey': colorIndicator.style.backgroundColor = '#9AA0A6'; break;
      case 'blue': colorIndicator.style.backgroundColor = '#4285F4'; break;
      case 'red': colorIndicator.style.backgroundColor = '#EA4335'; break;
      case 'yellow': colorIndicator.style.backgroundColor = '#FBBC04'; break;
      case 'green': colorIndicator.style.backgroundColor = '#34A853'; break;
      case 'pink': colorIndicator.style.backgroundColor = '#F6AEA9'; break;
      case 'purple': colorIndicator.style.backgroundColor = '#A142F4'; break;
      case 'cyan': colorIndicator.style.backgroundColor = '#24C1E0'; break;
      default: colorIndicator.style.backgroundColor = '#4285F4';
    }
    
    title.prepend(colorIndicator);
    
    info.appendChild(title);
    info.appendChild(details);
    
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    
    item.appendChild(toggle);
    item.appendChild(info);
    item.appendChild(actions);
    
    patternList.appendChild(item);
  });
}

/**
 * Populates the form with pattern data for editing
 * @param {Object} pattern - The pattern object to edit
 */
function editPattern(pattern) {
  currentPatternId = pattern.id;
  regexPattern.value = pattern.regex;
  groupName.value = pattern.groupName;
  useCapture.checked = pattern.useCapture;
  useRandomColor.checked = pattern.useRandomColor || false;
  
  document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
  document.querySelector(`.color-option[data-color="${pattern.color}"]`).classList.add('selected');
  selectedColor = pattern.color;
  
  addPatternBtn.textContent = 'Update Pattern';
}

/**
 * Deletes a pattern after confirmation
 * @param {string|number} id - The ID of the pattern to delete
 */
function deletePattern(id) {
  if (confirm('Are you sure you want to delete this pattern?')) {
    chrome.runtime.sendMessage(
      { action: 'deletePattern', id: id },
      response => {
        if (response.success) {
          loadPatterns();
          if (currentPatternId === id) {
            resetForm();
          }
        }
      }
    );
  }
}

/**
 * Toggles the active state of a pattern
 * @param {string|number} id - The ID of the pattern to toggle
 * @param {boolean} active - Whether the pattern should be active
 */
function togglePattern(id, active) {
  chrome.runtime.sendMessage(
    { action: 'getPatterns' },
    response => {
      const patterns = response.patterns || [];
      const index = patterns.findIndex(p => p.id === id);
      
      if (index !== -1) {
        patterns[index].active = active;
        chrome.runtime.sendMessage(
          { action: 'savePattern', pattern: patterns[index] },
          response => {
            if (response.success) {
              loadPatterns();
            }
          }
        );
      }
    }
  );
}

/**
 * Resets the pattern form to add a new pattern
 */
function resetForm() {
  currentPatternId = null;
  regexPattern.value = '';
  groupName.value = '';
  useCapture.checked = true;
  useRandomColor.checked = false;
  selectedColor = 'blue';
  document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
  document.querySelector('.color-option[data-color="blue"]').classList.add('selected');
  addPatternBtn.textContent = 'Add Pattern';
}
