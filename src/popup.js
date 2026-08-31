(function () {
  'use strict';

  var DEFAULTS = { rewrite: true, color: true, debug: false };
  var inputs = {
    rewrite: document.getElementById('rewrite'),
    color: document.getElementById('color'),
    debug: document.getElementById('debug')
  };

  // The chart colour only means anything while the figures are being converted,
  // so the switch follows the main one rather than standing on its own.
  function reflectDependency() {
    var converting = inputs.rewrite.checked;
    inputs.color.disabled = !converting;
    inputs.color.closest('.row').classList.toggle('disabled', !converting);
  }

  chrome.storage.sync.get(DEFAULTS, function (stored) {
    inputs.rewrite.checked = stored.rewrite !== false;
    inputs.color.checked = stored.color !== false;
    inputs.debug.checked = stored.debug === true;
    reflectDependency();
  });

  function save() {
    reflectDependency();
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
