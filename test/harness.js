/*
 * A miniature Studio for the interceptor to talk to.
 *
 * Provides just enough of a browser - an XMLHttpRequest whose responses are
 * scripted per URL, a document element that carries the settings attributes,
 * and an event target - to load src/interceptor.js and drive it end to end.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function createEnvironment(routes, options = {}) {
  const attributes = Object.assign(
    { 'data-realview-rewrite': 'on', 'data-realview-debug': 'off' },
    options.attributes || {}
  );

  const sent = [];

  const documentElement = {
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    setAttribute: (name, value) => { attributes[name] = value; }
  };

  class Event {
    constructor(type) { this.type = type; }
  }
  class ProgressEvent extends Event {
    constructor(type, init = {}) { super(type); Object.assign(this, init); }
  }

  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.responseURL = '';
      this.responseType = '';
      this.withCredentials = false;
      this._listeners = {};
      this._headers = {};
    }

    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(name, value) { this._headers[name] = value; }
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
    abort() { this._aborted = true; }

    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener() {}
    dispatchEvent(event) {
      const handler = this['on' + event.type];
      if (typeof handler === 'function') handler.call(this, event);
      (this._listeners[event.type] || []).forEach((fn) => fn.call(this, event));
      return true;
    }

    send(body) {
      sent.push({ url: this._url, body });
      const route = Object.keys(routes).find((key) => this._url.includes(key));
      const reply = route ? routes[route] : null;

      const finish = () => {
        // Assign through the backing fields: the interceptor shadows the
        // accessors on instances it proxies, leaving them getter-only.
        if (!reply) {
          this.status = 404;
          this._responseText = '';
        } else if (typeof reply === 'function') {
          const produced = reply(body, this);
          this.status = produced.status === undefined ? 200 : produced.status;
          this._responseText = produced.text === undefined ? '' : produced.text;
        } else {
          this.status = 200;
          this._responseText = reply;
        }
        this.statusText = this.status === 200 ? 'OK' : 'Error';
        this._response = this._responseText;
        this.responseURL = this._url;
        this.readyState = 4;
        if (this.status === 0) this.dispatchEvent(new ProgressEvent('error'));
        else {
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new ProgressEvent('load'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        }
      };

      const delay = reply && reply.__delay ? reply.__delay : 0;
      if (delay === Infinity) return; // never answers, to exercise the deadline
      setTimeout(finish, delay);
    }
  }

  // The prototype patches the interceptor installs must be visible to instances.
  const proto = FakeXHR.prototype;
  Object.defineProperty(proto, 'responseText', {
    configurable: true,
    get() { return this._responseText === undefined ? '' : this._responseText; },
    set(value) { this._responseText = value; }
  });
  Object.defineProperty(proto, 'response', {
    configurable: true,
    get() { return this._response === undefined ? '' : this._response; },
    set(value) { this._response = value; }
  });

  const sandbox = {
    window: {},
    document: { documentElement },
    location: { origin: 'https://studio.youtube.com', pathname: '/' },
    XMLHttpRequest: FakeXHR,
    Event,
    ProgressEvent,
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Map,
    Promise,
    Object,
    Array,
    Number,
    String
  };

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'interceptor.js'), 'utf8');
  const load = new Function(
    'window', 'document', 'location', 'XMLHttpRequest', 'Event', 'ProgressEvent', 'console',
    source
  );
  load(sandbox.window, sandbox.document, sandbox.location, FakeXHR, Event, ProgressEvent, console);

  return { FakeXHR, sent, attributes, Event, ProgressEvent };
}

// Issues a request the way Studio would and resolves with what the page sees.
function request(env, url, body, responseType) {
  return new Promise((resolve) => {
    const xhr = new env.FakeXHR();
    if (responseType) xhr.responseType = responseType;
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', 'test');
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, response: xhr.response });
    xhr.onerror = () => resolve({ status: xhr.status, text: xhr.responseText, error: true });
    xhr.send(body);
  });
}

module.exports = { createEnvironment, request };
