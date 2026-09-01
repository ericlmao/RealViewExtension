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
- **Traffic sources, countries, devices, age against gender and the rest** — the tables that break
  views down by something, one dimension or two, including the ones that report only each row's
  share rather than the views themselves; those shares are worked out again from the converted
  figures. A table split two ways is asked for split the same way, and each row takes the figure
  for its own pair of names. A card that repeats the same breakdown once per kind of content -
  the All, Videos, Shorts and Live tabs - is asked about one kind at a time, so the Shorts tab
  gets the Shorts figures rather than the channel's. A kind RealView cannot name to the query
  endpoint, such as podcasts, is left raw rather than filled with the whole channel's numbers. Traffic *detail*
  rows — a search term, a linking site — are asked for one kind of source at a time, since the
  server refuses a query that does not say which kind it means; the row names carry that as a
  prefix. A table listing sources *and* their details together — "YouTube recommendations" with
  "YouTube Home" beneath it — is rebuilt from both levels at once, since the server answers each
  on its own but not the two together.
- **View counts a card keeps for itself** — the retention curve reports a video's views alongside
  its own figures rather than as a metric column, and the latest-video card reports each of its
  metrics as a row naming the video once at the top. Both are converted.

- **The latest-video ranking** — "6 of 10", and the list of recent videos behind it. Studio ranks
  the newest video against recent uploads over the same stretch of each one's life, counted in
  raw views. RealView asks Studio's video list for each one's publish time, measures every video
  over that same span from its own start, reorders the list by engaged views and renumbers it.
  Videos that tie share a place, as Studio does it. If any video in the list cannot be dated, the
  ranking is left exactly as the server sent it rather than half rebuilt.

  The card beside the ranking also carries the server's judgement of the same figures: a typical
  band and an arrow saying whether this video sits above it, inside it or below it. Both were made
  from raw views, so once the ranking is engaged they are redone from the same engaged figures —
  the band becomes the middle half of the list, and the arrow follows from where the video's own
  figure lands in it. If the verdict changes, the sentence the server wrote for the old one
  ("Looking good! This video is performing as usual") is dropped rather than left to contradict
  the arrow. A row the server did not judge is left unjudged.

Any card that mentions views and had nothing converted inside it is taken at its word, and the
wording on that screen is left as Studio wrote it.

A screen is only relabelled once every figure on it has really been converted, so a raw count is
never captioned as an engaged one. Two things are exempt: sparklines - a run of time buckets split
by something else - which carry no caption and are not worth rebuilding, and the "views are counted
differently now" notices, which name the metric without reporting any figure.

Because a card can arrive after the screen it belongs to, that verdict can be withdrawn: a later
response that leaves figures raw puts Studio's own wording back.

`relabel.js` corrects the wording on the analytics screens, the dashboard and the video list —
and only once the interceptor confirms the numbers on that surface really changed.

## How it works

Studio's data comes from `https://studio.youtube.com/youtubei/v1/`, over `XMLHttpRequest`. The
endpoints expose the metric to the client to different degrees, so RealView uses a different
technique for each:

| Endpoint | What it serves | Technique |
| --- | --- | --- |
| `creator/get_channel_dashboard` | The channel dashboard | Both at once: the queries it names are asked for the engaged metric and renamed back, and the figures its cards keep for themselves are substituted |
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

### Charts that run to this moment

A video's "since published" chart plots a running total rather than each day on its own, and its
last point is the figure as it stands now.

Both the line and the figure above it are built from the same list of time buckets, so the two
cannot disagree: the figure is their sum, the line is their running total. The buckets have to be
at least as fine as the chart's own points — such a chart draws several points inside a single
day, and a day-sized bucket cannot say how much of that day had accrued by each of them. Hours
are used for a window short enough to make that sensible, days plus today's hours for anything
longer, since the daily store trails the live one by hours, which on a day-old video is most of
its views.

Two rules of the query endpoint shape this, both found by experiment: a query with no dimension
at all is refused over a clock-time range, and an hourly one is refused unless its window lands
on whole hours.

### One refused query is only one refused query

The server fails an entire request when any single query inside it is unsupported. A batch that
comes back with anything missing is therefore sent again — first as a group, in case it simply
did not arrive, then a query at a time, which is what finds the one the server will not accept.
An unsupported query then costs only itself rather than every figure on the screen.

All of that happens inside one time budget, which grows with the number of questions the screen
asks: a screen wanting a dozen tables is given longer than one wanting two, and a backend that
hangs still cannot hold the page. Running out of time is treated as slowness rather than
malfunction, so it does not count towards standing the extension down.

An answer with no rows in it is not a failure either: it means there were no engaged views in
that window, so the table reads zero rather than staying raw.

### The typical range

Studio compares a figure against a band it calls typical, and the server only models that band
for raw views: ask it for the engaged one and it answers with nothing, which is what turned the
dashboard's arrow into "Comparison not available".

So RealView leaves the typical query as Studio wrote it — that also keeps watch time's own band
intact — and replaces the views part with a band worked out from the channel's own engaged
history: the same number of days over each of the preceding eight periods, reduced to a middle
value and a quartile range. Fewer than four periods with data and the comparison is dropped
rather than guessed at.

### A column the swapped query already answered

The dashboard's own queries have their metric swapped on the way out, so their answers arrive
already engaged — over whatever window the server chose for each of them. The top-content list is
one: the server picks its videos and counts them over the last 48 hours. Those columns must not
be converted again on the way in, because the second pass would use the request's own 28-day
window and overwrite the right figures with wrong ones. A column that came back already engaged
is recognised and left exactly as answered.

### A screen that names no period

Most screens name the period they want in the request. The Audience screen does
not: it asks with a channel and nothing else, and the period it settled on
appears only in the answer, under `layout.desktopLayout.selectedTimePeriod`. A
screen with no period has no date range, and a table with no range cannot be
asked about, so every table on that screen would stay raw. The range is
therefore taken from the response when the request is silent.

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
- A table broken down by two dimensions is rebuilt from an answer split the same way, matched on
  the pair of names that identifies each row. If the answer cannot be lined up, the table is left
  alone rather than half-converted.
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
