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
    var converting = settings.rewrite !== false;
    // The red charts mark figures that are engaged views. With the conversion
    // switched off the figures are Studio's own, so they keep Studio's colour.
    var red = converting && settings.color !== false;
    root.setAttribute('data-realview-rewrite', converting ? 'on' : 'off');
    root.setAttribute('data-realview-color', red ? 'on' : 'off');
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
