/*
 * RealView - settings bridge.
 *
 * Runs in the extension's isolated world at document_start. The interceptor
 * lives in the page's own context and cannot touch chrome.storage, so the
 * current settings are mirrored onto the <html> element, where both the
 * interceptor and the stylesheet can read them.
 */
(function () {
  'use strict';

  var DEFAULTS = { rewrite: true, color: true, debug: false, skip: '' };

  function apply(settings) {
    var root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-realview-rewrite', settings.rewrite === false ? 'off' : 'on');
    root.setAttribute('data-realview-color', settings.color === false ? 'off' : 'on');
    root.setAttribute('data-realview-debug', settings.debug === true ? 'on' : 'off');
    root.setAttribute('data-realview-skip', settings.skip || '');
  }

  // Assume the defaults immediately: storage reads are asynchronous and Studio
  // fires its first analytics request before they resolve.
  apply(DEFAULTS);

  chrome.storage.sync.get(DEFAULTS, function (stored) {
    apply(stored || DEFAULTS);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    chrome.storage.sync.get(DEFAULTS, function (stored) {
      apply(stored || DEFAULTS);
    });
  });
})();
