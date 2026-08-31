(function () {
  'use strict';

  var DEFAULTS = { rewrite: true, color: true, debug: false };
  var inputs = {
    rewrite: document.getElementById('rewrite'),
    color: document.getElementById('color'),
    debug: document.getElementById('debug')
  };

  chrome.storage.sync.get(DEFAULTS, function (stored) {
    inputs.rewrite.checked = stored.rewrite !== false;
    inputs.color.checked = stored.color !== false;
    inputs.debug.checked = stored.debug === true;
  });

  function save() {
    chrome.storage.sync.set({
      rewrite: inputs.rewrite.checked,
      color: inputs.color.checked,
      debug: inputs.debug.checked
    });
  }

  Object.keys(inputs).forEach(function (name) {
    inputs[name].addEventListener('change', save);
  });
})();
