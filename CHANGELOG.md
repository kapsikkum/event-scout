# Changelog

Every release is listed here. From 0.2.0 onward this file is written by
[release-please](https://github.com/googleapis/release-please) from the commit
subjects on `main` — see [Releasing](README.md#releasing) for how that works and
what a commit has to look like to appear here.

The entries below 0.2.0 were written by hand, since they predate the convention.

## [0.2.0](https://github.com/kapsikkum/event-scout/compare/v0.1.0...v0.2.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* the /api/density/waze, /api/density/waze/signin and /api/density/:area/waze routes are removed, as are the densityWaze, densityWazeHeadless, densityWazeHoldSeconds and densityWazeCookie settings. Stored settings keep those keys harmlessly; they are ignored. POST /api/tasks/:name/run no longer reads holdSeconds from its body.

### Features

* add the MIDNIGHT_SPEC car meet source ([d2dce70](https://github.com/kapsikkum/event-scout/commit/d2dce70ce7eead88cd282fd03ebeced2be7a0a1b))
* put a console at the foot of the Tasks tab ([3e293d6](https://github.com/kapsikkum/event-scout/commit/3e293d69253aa873890f356c468aa43924f52b99))
* put changes behind a password, leaving reading open ([885c462](https://github.com/kapsikkum/event-scout/commit/885c4620e3cc433b3f5fe81790e8546b003ab136))
* read event flyers with a dedicated vision model ([e454c40](https://github.com/kapsikkum/event-scout/commit/e454c405eba71377d50b932f4a7689bc162e594e))
* read scraped listings with a local model ([287ce43](https://github.com/kapsikkum/event-scout/commit/287ce437f9130c3707c0c13d2208feac586ae283))
* remove the Waze live-map source ([4af5c73](https://github.com/kapsikkum/event-scout/commit/4af5c734d397401d75be602a84e264e17c1c084a))
* run background jobs as tasks you can see and start ([58fa3dc](https://github.com/kapsikkum/event-scout/commit/58fa3dcce2a16b0ccaefc3412e9620817f05f072))
* split Settings into tabs and move Tasks into it ([d4b4d03](https://github.com/kapsikkum/event-scout/commit/d4b4d03b641141bd066bd4b7444476f5279dcf46))
* walk through setup a step at a time on a first run ([f08e4f7](https://github.com/kapsikkum/event-scout/commit/f08e4f7bb7dbdd9a87d6fcafb2ea983a9bf75b0b))


### Fixes

* ask before forgetting what the models decided ([4360aaf](https://github.com/kapsikkum/event-scout/commit/4360aaf2b0c429a8cc4c0fdc6e8710c41c27e759))
* ask the model only what the listing has not already answered ([97e42b0](https://github.com/kapsikkum/event-scout/commit/97e42b0a96f1176623cd77643162e22fb4b6da58))
* correct two stale strings on the Tasks tab ([729a5d1](https://github.com/kapsikkum/event-scout/commit/729a5d1c6453f4146dac302c590d24be225dbb59))
* give setup its own address so the nav bar stays quiet ([519b6d8](https://github.com/kapsikkum/event-scout/commit/519b6d8eb4642e266b9dc1022190c0de1b7a69b4))
* keep first-run setup on one page ([4123363](https://github.com/kapsikkum/event-scout/commit/4123363d60df3510c533ff4609b4b555954486cb))
* name the zone in the start-time test rather than inheriting one ([56b382b](https://github.com/kapsikkum/event-scout/commit/56b382b8cee1cf9efd3ebb35953c66e8407f5345))
* stop the test files racing each other for the database ([0691317](https://github.com/kapsikkum/event-scout/commit/06913171f667a0138c54326a70d886c0bed2b30a))


### Documentation

* rewrite the README as reference, and document the API ([f10e3b4](https://github.com/kapsikkum/event-scout/commit/f10e3b4a007979a3cc1816e532ac0b64b67eb5fe))


### Build and packaging

* derive versions and image tags from the commits ([53a46fc](https://github.com/kapsikkum/event-scout/commit/53a46fccf83778eacc5b8b5682e3129004c7e0da))
* point the deployed container at squareeyes for Ollama ([9400488](https://github.com/kapsikkum/event-scout/commit/9400488fcf5e232a2de586d1fe8acdde1fcd2a29))
* publish images even when the release pull request cannot be opened ([8a3798e](https://github.com/kapsikkum/event-scout/commit/8a3798e751bbab977387522d32e192cfdf9042b4))

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
