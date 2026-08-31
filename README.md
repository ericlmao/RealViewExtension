# RealView

A Chrome extension that makes YouTube Studio report **engaged views** — the old definition of a
view — instead of the raw view count, across every surface that shows one. It also paints the
analytics charts red.

## Why

YouTube changed the definition of a view in 2025: a view is now counted the instant playback
starts, rather than after roughly 30 seconds of watch time. The old definition survives in the
analytics API under the name `ENGAGED_VIEWS`, but Studio leads with the new one everywhere.

On the channel this was built against the difference is real: over 365 days the raw count was
953 and the engaged count 938; over 28 days, 60 against 47; over 7 days, 24 against 11.

## How it works

Studio's data comes from `https://studio.youtube.com/youtubei/v1/`, over `XMLHttpRequest`. Three
endpoints matter, and they expose the metric to the client to different degrees, so RealView
uses a different technique for each:

| Endpoint | What it serves | Technique |
| --- | --- | --- |
| `creator/get_channel_dashboard` | The channel dashboard | The request names the metric it wants, so it is asked for the engaged one and the answer renamed back |
| `yta_web/join` | Queries Studio composes itself | Same |
| `yta_web/get_screen` | Analytics screens, including the realtime card | The request names no metric and the server always answers raw, so the response is held and its figures are substituted |
| `yta_web/get_cards` | Analytics card data | Same |
| `creator/list_creator_videos` | The Content tab's video list | Same, except no engaged figure exists in the response at all, so lifetime counts are looked up per video |

Where a request names its own metric, asking for a different one is enough and the answer is
renamed back so the caller's own bookkeeping still lines up. Where it does not, RealView holds
the response, reads which figures came back as `EXTERNAL_VIEWS`, asks `join` — in a single extra
request per screen — for the engaged equivalent of exactly those figures over exactly the same
dates, and substitutes the numbers.

### Substitute the figures, keep the names

Studio matches a card's configured metric against the columns it receives, and **a column it
cannot find makes it discard the entire screen** — which shows up as an analytics page that
renders its tabs and then nothing else, forever. So a substituted column keeps the name Studio
configured for it, and only the numbers change.

The one exception is the key metric card, where the tab's configured metric and the figure it
labels both live in the same payload: those are renamed together, which is why that card says
"Engaged views" on its own. Everywhere else the wording is corrected in the page by
`relabel.js`, and only once the interceptor confirms every figure on that screen really was
converted.

### Speed

The obvious way to write this costs a round trip: fetch the screen, then fetch its engaged
figures. RealView avoids that. The screen request names the period it wants
(`ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS` and friends), so the date range is known *before* the
response arrives and the engaged query is fired at the same moment as the screen request rather
than after it. The guess is checked against the response and anything it missed is filled in.
Results are cached for a minute, so switching tabs and flipping between periods you have already
looked at costs nothing at all.

### Not lying is the design constraint

Renaming a metric without replacing the numbers is easy, and produces a Studio that claims to
show engaged views while displaying raw ones. RealView never does this:

- Any query that fails, or does not answer within four seconds, is abandoned and the original
  response is passed through untouched. A screen can never be left waiting on this extension.
- A card is only renamed when its figures were really replaced.
- The daily chart is dropped rather than left drawn from raw views under an engaged label.
- "About the same as usual" and the "views are counted differently now" notice are computed from
  the raw metric by the server and cannot be recomputed here, so they are removed from converted
  cards.
- A table broken down by two dimensions at once cannot be rebuilt from a one-dimensional answer,
  so it is left alone rather than half-converted.
- An error from Studio itself is relayed exactly as it arrived, so Studio's own retry and error
  handling behave as they would without the extension.

### Never blocking a screen

Holding a response means the extension is briefly responsible for delivering it, so every way
that could go wrong is closed off:

- Anything unexpected thrown inside the extension is caught, and the request goes out untouched
  rather than throwing into Studio's networking code.
- A retargeted request the server refuses is retried once, exactly as Studio wrote it.
- Two watchdogs guarantee an answer: one if the conversion never finishes, one covering the
  whole exchange. A screen cannot end up waiting on this extension.
- After two faults of the extension's own making, it stands down for the rest of the page and
  Studio serves its own figures. A systematic problem costs the engaged numbers, never the page.

## What it covers

- **Analytics** — the headline metric card, its comparison figure and daily chart, the sentence
  above the cards, and every table's view column. Channel, video and playlist scopes.
- **Realtime** — the 48-hour card, including its hourly chart and its top-videos table, queried
  over exactly the hours the card draws.
- **Channel dashboard** — the summary card and top content.
- **Content tab** — the video list's lifetime view counts.

`relabel.js` corrects the wording on the analytics screens, the dashboard and the video list —
and only once the interceptor confirms the numbers on that surface really changed.

## Red charts

Studio draws its charts as inline SVG with the colour written into `stroke` and `fill`
attributes, which a stylesheet rule outranks. `charts.css` recolours them by class and by
attribute value, so it catches the line series, the area fill, the realtime bars and anything
else painted in the default accent colour. Everything is scoped to an attribute the settings
bridge writes, so turning the option off restores Studio's palette with no cleanup.

## Troubleshooting

Turn on **Log to the console** in the popup; each converted response reports what it changed and
any fault reports why it gave up.

There is also a diagnostic switch for narrowing a problem down to one surface. In the console on
any Studio page:

    chrome.storage.sync.set({ skip: 'screen,cards,videos,join' })

Any subset of those names is left entirely alone until you set it back to `''`.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this repository's `src` directory, or the
   `RealView-extension` folder in Downloads if you are using the packaged build.
4. Open <https://studio.youtube.com>.

Chrome 111 or newer is required, because the interceptor is declared with `"world": "MAIN"`.

## Files

| File | Runs in | Purpose |
| --- | --- | --- |
| `manifest.json` | — | Manifest V3 declaration |
| `interceptor.js` | page context | Retargets, swaps and substitutes the view figures |
| `bridge.js` | isolated world | Mirrors saved settings onto `<html>` |
| `relabel.js` | isolated world | Corrects the wording Studio writes itself |
| `charts.css` | isolated world | Paints the charts red |
| `popup.html` / `popup.js` | popup | Three switches, stored in `chrome.storage.sync` |

## Tests

    node test/interceptor.test.js

`test/harness.js` stands up a miniature Studio — a scripted `XMLHttpRequest`, a document element
carrying the settings, an event target — and loads `src/interceptor.js` into it unmodified. The
suite covers each conversion technique, the parallel query, the cache, the four-second deadline,
a failing query, an error from Studio, the disabled state, the exact event sequence a rewritten
response is delivered with, a refused request being retried, an exception inside the extension,
and the fault limit standing the extension down.
