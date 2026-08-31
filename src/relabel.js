/*
 * RealView - relabelling, in the extension's isolated world.
 *
 * Most of Studio takes a card's wording from the metric name, so replacing the
 * metric is enough and nothing here is needed. Two surfaces write the word
 * "Views" themselves: the channel dashboard and the Content tab's video list.
 * Those are relabelled here, and only on the page they belong to, and only
 * after the interceptor has confirmed it really replaced their numbers.
 *
 * Chart colour is handled entirely by charts.css. Watching the whole tree for
 * attribute changes to repaint it in script would cost far more than the
 * stylesheet does.
 */
(function () {
  'use strict';

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1 };

  function converted(name) {
    return document.documentElement.getAttribute('data-realview-converted-' + name) === 'yes';
  }

  // Every rewording is remembered, so that a response arriving later - a card
  // fetched as it scrolls into view, say - can withdraw the verdict and put
  // Studio's own wording back rather than leave a raw figure captioned wrongly.
  var rewritten = [];

  function revert() {
    for (var i = 0; i < rewritten.length; i++) {
      var entry = rewritten[i];
      if (entry.node.nodeValue === entry.after) entry.node.nodeValue = entry.before;
    }
    rewritten.length = 0;
  }

  function active() {
    var path = location.pathname;
    if (/\/analytics(\/|$)/.test(path)) return converted('analytics');
    if (/^\/channel\/[^/]+\/?$/.test(path)) return converted('dashboard');
    if (/\/(videos|playlists|podcasts)(\/|$)/.test(path)) return converted('videolist');
    return false;
  }

  function skip(node) {
    var parent = node.parentNode;
    while (parent && parent.nodeType === 1) {
      if (SKIP_TAGS[parent.tagName] || parent.isContentEditable) return true;
      parent = parent.parentNode;
    }
    return false;
  }

  // The word is only rewritten where it is the label itself, never where it
  // merely appears in prose or in something a viewer wrote. Each pattern
  // anchors the word to the shape of a real Studio label:
  //
  //   "Views"                       a column heading or a metric caption
  //   "· Views"                     the trailing half of a card heading
  //   "Views · Last 48 hours"       the leading half of one
  //   "Latest activity, Views: ..." the spoken description of a card
  //   "Total views for the ..."      the note explaining what a card counts
  //   "Ranking by views"             the heading over the latest-video ranking
  //
  // A video title such as "my views on this" matches none of them.
  var PATTERNS = [
    /^(\W*)(Views|views)$/,
    /^(\W*)(Views|views)(\s*[·|].*)$/,
    /^(.*,\s*)(Views|views)(\s*:.*)$/,
    /^(Total\s+)(views)(\s+for\b.*)$/,
    /^(Ranking by\s+)(views)$/
  ];
  var MAX_LABEL = 100;

  function relabel(node) {
    var text = node.nodeValue;
    if (!text) return;

    var trimmed = text.trim();
    if (trimmed.length > MAX_LABEL) return;
    if (!/views/i.test(trimmed)) return;
    if (/engaged\s+views/i.test(trimmed)) return;

    for (var i = 0; i < PATTERNS.length; i++) {
      var match = trimmed.match(PATTERNS[i]);
      if (!match) continue;
      if (skip(node)) return;
      var word = match[2];
      var after = text.replace(word, word === 'Views' ? 'Engaged views' : 'engaged views');
      rewritten.push({ node: node, before: text, after: after });
      node.nodeValue = after;
      return;
    }
  }

  function sweep(root) {
    if (!root || !active()) return;
    if (root.nodeType === 3) { relabel(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) relabel(node);

    var elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].shadowRoot) observe(elements[i].shadowRoot);
    }
  }

  var observed = new WeakSet();

  function observe(root) {
    if (!root || observed.has(root)) return;
    observed.add(root);
    sweep(root);
    new MutationObserver(function (mutations) {
      if (!active()) return;
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.type === 'characterData') relabel(mutation.target);
        else for (var j = 0; j < mutation.addedNodes.length; j++) sweep(mutation.addedNodes[j]);
      }
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  function start() { observe(document.body || document.documentElement); }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  // The flags are set once a response has been converted, which happens after
  // the first sweep, so run again when one appears.
  new MutationObserver(function () {
    if (active()) sweep(document.body);
    else revert();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'data-realview-converted-analytics',
      'data-realview-converted-dashboard',
      'data-realview-converted-videolist'
    ]
  });

  window.addEventListener('yt-navigate-finish', function () { sweep(document.body); });
})();
