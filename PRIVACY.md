# Privacy policy

Last updated: 31 August 2026

RealView is a Chrome extension that changes which view metric YouTube Studio
displays. This page describes everything it does with data.

## The short version

RealView collects nothing, transmits nothing to its developer, and shares
nothing with anyone. There are no accounts, no analytics, no tracking, and no
advertising. Every figure it handles stays in your browser.

## What it processes

RealView runs only on `https://studio.youtube.com`. On those pages it reads the
analytics data that YouTube Studio has already loaded for your own channel: view
counts, the figures behind the charts, and the tables that break those figures
down. It uses them to work out which numbers to replace, and replaces them
before Studio draws the page.

To get the engaged-view figures, RealView asks YouTube's own analytics service
for them, at the same `studio.youtube.com` address Studio itself uses, using the
session you are already signed in with. Those requests go to YouTube and nowhere
else. The answers are used to draw the page and are held in memory only, for up
to a minute, so that moving between screens does not ask the same question
twice. They are not written to disk.

This processing happens entirely on your computer. None of it is sent to the
developer of this extension or to any third party.

## What it stores

RealView stores three settings, the ones shown in its toolbar popup:

- whether to show engaged views
- whether to colour the charts red
- whether to write diagnostic messages to the browser console

They are stored with the Chrome `storage.sync` API, which is what Chrome
provides for keeping a user's settings across the browsers they are signed into.
If you have Chrome sync switched on, Chrome carries these three settings to your
other Chrome profiles, in the same way it carries your bookmarks. That transfer
is between you and Chrome. The developer of this extension cannot see it.

Nothing else is stored. RealView does not use cookies, local storage, session
storage or a database, and it keeps no record of the analytics figures it reads.

## What it does not do

- It does not collect personally identifiable information, health information,
  financial information, credentials, personal communications, or location.
- It does not read your browsing history or record what pages you visit. It runs
  on one site and does nothing anywhere else.
- It does not track clicks, scrolling, mouse movement or keystrokes.
- It does not sell or transfer any data, and it does not use data for anything
  unrelated to replacing the view figures in YouTube Studio.
- It does not modify your channel. It changes what Studio shows you. Your
  viewers, your public view counts and your channel's data are untouched.

## Permissions

RealView requests two permissions, both needed for the single purpose above:

- `storage`, required by the Chrome API that saves the three settings.
- Access to `https://studio.youtube.com/*`, the one site whose figures it
  changes. No other site is matched, and no request is made to any other domain.

## Removing your data

The three settings are the only data that persists. Removing the extension from
Chrome deletes them. You can also reset them at any time from the popup.

## Children

RealView is a tool for people who manage a YouTube channel. It is not directed
at children and collects nothing from anyone.

## Changes

If this policy changes, the updated version will appear here with a new date at
the top.

## Contact

Questions and problems can be raised at
<https://github.com/ericlmao/RealViewExtension/issues>.
