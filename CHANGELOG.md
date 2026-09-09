# Changelog

Every release is listed here. From 0.2.0 onward this file is written by
[release-please](https://github.com/googleapis/release-please) from the commit
subjects on `main` — see [Releasing](README.md#releasing) for how that works and
what a commit has to look like to appear here.

The entries below 0.2.0 were written by hand, since they predate the convention.

## 0.1.0

The first working version, developed before this changelog existed. Summarised
rather than enumerated.

### Features

- Aggregate events from Ticketmaster, SeatGeek, Eventbrite, Facebook, web search
  and iCal feeds, de-duplicated into one card per event with every source linked.
- Score events for photographic appeal, and sort by soonest, best for photos, or
  nearest.
- Events, map, calendar and places views; a shortlist that exports as `.ics`, and
  a subscribable calendar feed.
- Search several areas at once, with each event filed under the town it belongs
  to and anything out of reach put under Elsewhere.
- Sample venue busyness on its own schedule, with a density overlay on the map
  and a per-venue history.
- Sun, moon and weather conditions for planning a shoot.
- Run the whole thing from Docker Compose, with a Chromium container for the
  sources that need a real browser.
