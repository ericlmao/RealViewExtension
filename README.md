# RealView

A Chrome extension that makes YouTube Studio show **engaged views** — the older definition of a
view, counted after roughly 30 seconds of watching — everywhere it normally shows the newer Views
figure. It also colours the analytics graphs red.

---

## Setup

You need Google Chrome, version 111 or newer. That is any Chrome from the last couple of years.

**1. Unzip the file.** Unzip `RealView-extension.zip`. You will get a folder called
`RealView-extension`. Put it somewhere permanent, such as Documents. Chrome loads the extension
from this folder every time it starts, so it must not be moved or deleted afterwards.

**2. Open Chrome's extensions page.** Type `chrome://extensions` into the address bar and press
Enter.

**3. Turn on Developer mode.** The switch is in the top right corner of that page.

**4. Click "Load unpacked".** The button appears in the top left once Developer mode is on.

**5. Choose the folder.** Select the `RealView-extension` folder itself — not the zip file, and
not a file inside it. RealView now appears in your list of extensions.

**6. Check it worked.** Go to <https://studio.youtube.com> and open Analytics. The main card
should read "Engaged views" instead of "Views", and the graph should be red.

The number will be lower than the Views figure you saw before. That is expected, and is the whole
point: it leaves out people who clicked away within the first few seconds.

### Turning it on and off

Click the RealView icon in the Chrome toolbar. You may need to click the puzzle-piece icon first
and pin RealView to see it. The popup has three switches:

- **Use engaged views** — the main switch. Turn it off and Studio behaves exactly as it normally
  does.
- **Red charts** — the graph colour. It only applies while engaged views are being shown; with
  the switch above turned off the graphs go back to YouTube's own blue.
- **Log to the console** — for diagnosing a problem. Leave it off for normal use.

### Things worth knowing

- Chrome shows a "Disable developer mode extensions" warning each time it starts. That is normal
  for any extension installed this way, and can be dismissed. RealView keeps working.
- RealView only runs on studio.youtube.com and does nothing on any other site.
- No data is sent anywhere. The extension asks YouTube's own analytics service for the engaged
  figures using your existing signed-in session, and shows them in place of the raw ones. Nothing
  leaves your browser and nothing is stored.
- Your channel is not modified. This changes what Studio shows you; other people see nothing
  different.
- If a page ever looks wrong, switch **Use engaged views** off and reload. Studio returns to
  normal immediately.

---

## Why

YouTube changed the definition of a view in 2025: a view is now counted the instant playback
starts, rather than after roughly 30 seconds of watch time. The old definition survives in the
analytics API under the name `ENGAGED_VIEWS`, but Studio leads with the new one everywhere.

On the channel this was built against the difference is real: over 365 days the raw count was
953 and the engaged count 938; over 28 days, 60 against 47; over 7 days, 24 against 11.

## What it covers

- **Analytics** — the headline metric card, its comparison figure and daily chart, the sentence
  above the cards, and every table's view column. Channel, video and playlist scopes.
- **Realtime** — the 48-hour card, including its hourly chart and its top-videos table, queried
  over exactly the hours the card draws.
- **Channel dashboard** — the summary card and top content.
- **Content tab** — the video list's lifetime view counts.

Not covered: the **latest video performance** card, whose figures arrive in a shape the
substitution cannot reach. A screen carrying that card is left with Studio's own wording, so its
raw count is never captioned as an engaged one.

`relabel.js` corrects the wording on the analytics screens, the dashboard and the video list —
and only once the interceptor confirms the numbers on that surface really changed.

## How it works

Studio's data comes from `https://studio.youtube.com/youtubei/v1/`, over `XMLHttpRequest`. The
endpoints expose the metric to the client to different degrees, so RealView uses a different
technique for each:

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

### The typical range

Studio compares a figure against a band it calls typical, and the server only models that band
for raw views: ask it for the engaged one and it answers with nothing, which is what turned the
dashboard's arrow into "Comparison not available".

So RealView leaves the typical query as Studio wrote it — that also keeps watch time's own band
intact — and replaces the views part with a band worked out from the channel's own engaged
history: the same number of days over each of the preceding eight periods, reduced to a middle
value and a quartile range. Fewer than four periods with data and the comparison is dropped
rather than guessed at.

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
- The "views are counted differently now" notice is removed from converted cards, since it
  describes a metric they are no longer showing.
- A table broken down by two dimensions at once cannot be rebuilt from a one-dimensional answer,
  so it is left alone rather than half-converted.
- An error from Studio itself is relayed exactly as it arrived, so Studio's own retry and error
  handling behave as they would without the extension.

### Never blocking a screen

Holding a response means the extension is briefly responsible for delivering it, so every way
that could go wrong is closed off:

- Anything unexpected thrown inside the extension is caught, and the request goes out untouched
  rather than throwing into Studio's networking code.
- Two watchdogs guarantee an answer: one if the conversion never finishes, one covering the whole
  exchange. A screen cannot end up waiting on this extension.
- After two faults of the extension's own making, it stands down for the rest of the page and
  Studio serves its own figures. A systematic problem costs the engaged numbers, never the page.

## Red charts

The red is a signal that a figure is an engaged view rather than Studio's own, so it is tied to
the conversion: turning engaged views off puts the graphs back to YouTube's blue whatever the
colour switch says, and the popup dims that switch to show it no longer applies.

Studio draws its charts as inline SVG with the colour written into `stroke` and `fill`
attributes, which a stylesheet rule outranks. `charts.css` recolours them by class and by
attribute value, so it catches the line series, the area fill, the realtime bars and anything
else painted in the default accent colour. Everything is scoped to an attribute the settings
bridge writes, so turning the option off restores Studio's palette with no cleanup.

## Diagnosing a problem

Turn on **Log to the console** in the popup; each converted response reports what it changed, and
any fault reports why it gave up.

There is also a switch for narrowing a problem down to one surface. In the console on any Studio
page:

    chrome.storage.sync.set({ skip: 'screen,cards,videos,join' })

Any subset of those names is left entirely alone until you set it back to `''`.

## Files

| File | Runs in | Purpose |
| --- | --- | --- |
| `manifest.json` | — | Manifest V3 declaration |
| `interceptor.js` | page context | Swaps and substitutes the view figures |
| `bridge.js` | isolated world | Mirrors saved settings onto `<html>` |
| `relabel.js` | isolated world | Corrects the wording Studio writes itself |
| `charts.css` | isolated world | Paints the charts red |
| `popup.html` / `popup.js` | popup | Three switches, stored in `chrome.storage.sync` |

Developers can point **Load unpacked** at this repository's `src` directory instead of the
packaged folder.

## Tests

    node test/interceptor.test.js

`test/harness.js` stands up a miniature Studio — a scripted `XMLHttpRequest`, a document element
carrying the settings, an event target — and loads `src/interceptor.js` into it unmodified. The
suite covers each conversion technique, the parallel query, the cache, the four-second deadline,
a failing query, an error from Studio, the disabled state, the exact event sequence a rewritten
response is delivered with, an exception inside the extension, and the fault limit standing the
extension down.
