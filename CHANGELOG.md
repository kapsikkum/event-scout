# Changelog

Every release is listed here. From 0.2.0 onward this file is written by
[release-please](https://github.com/googleapis/release-please) from the commit
subjects on `main` — see [Releasing](README.md#releasing) for how that works and
what a commit has to look like to appear here.

The entries below 0.2.0 were written by hand, since they predate the convention.

## [0.7.1](https://github.com/kapsikkum/event-scout/compare/v0.7.0...v0.7.1) (2026-09-11)


### Fixes

* **notify:** a blank chat system prompt means the default persona again ([6c50627](https://github.com/kapsikkum/event-scout/commit/6c50627691b38221c4e95069f347df858c6643cb))
* **places:** a town inside an area keeps its own name ([bfde0f5](https://github.com/kapsikkum/event-scout/commit/bfde0f5b8701e064d5abfef4b946e5bf33fc14c7))
* **web:** pick several towns and categories at once, and show past days in the calendar ([109b94e](https://github.com/kapsikkum/event-scout/commit/109b94edb331e4f11d7a9f6b4e7c855c809ac438))

## [0.7.0](https://github.com/kapsikkum/event-scout/compare/v0.6.0...v0.7.0) (2026-09-11)


### Features

* add an event from a link ([322d279](https://github.com/kapsikkum/event-scout/commit/322d279d96e2cfd73a15c4e3033da9f1a1b77497))
* **crawler:** place an Instagram post in the area its caption names ([c70c423](https://github.com/kapsikkum/event-scout/commit/c70c4231b96c7143967e4c65a7ef1c437cbe9e93))
* hide events outside your areas or in excluded categories, reversibly ([0c159a8](https://github.com/kapsikkum/event-scout/commit/0c159a80d2d3d33c01f18fc860d222f1e743b0fd))
* **notify:** a bare-model chat, and !chat commands that change one chat ([a990357](https://github.com/kapsikkum/event-scout/commit/a990357f4bbc0771aeb542076fe7de88c55292c1))
* **notify:** a main switch for Matrix chat ([30aeb65](https://github.com/kapsikkum/event-scout/commit/30aeb65914cbefa041b228129aae8c17da5c7564))
* **notify:** answer commands in Matrix ([6177c50](https://github.com/kapsikkum/event-scout/commit/6177c505832e9cc69d060797a7f65baa78c6523a))
* **notify:** busy-place alerts and !busy from venue density, and a read-only Matrix bot ([2b502d7](https://github.com/kapsikkum/event-scout/commit/2b502d7bf36b7309cddf51d8ec45bda36e37c203))
* **notify:** Discord webhooks and Matrix rooms for new events, digests, reminders and changes ([6177c50](https://github.com/kapsikkum/event-scout/commit/6177c505832e9cc69d060797a7f65baa78c6523a))
* **notify:** give Matrix rooms the look, pings and filters Discord has ([ae830e8](https://github.com/kapsikkum/event-scout/commit/ae830e845d284fd3af0d817a5c1d6dd80945cf55))
* **notify:** Matrix looks to compare, and chat rooms answered by the local model ([7540017](https://github.com/kapsikkum/event-scout/commit/7540017a3c0840f473746f6d1ebd782cb613f933))
* **notify:** start and end a Matrix chat with !chat start and !chat end ([d884a23](https://github.com/kapsikkum/event-scout/commit/d884a237beb05dd27ca9a06ed04ed179b566de22))
* show events with no place at all as Unknown location ([0c159a8](https://github.com/kapsikkum/event-scout/commit/0c159a80d2d3d33c01f18fc860d222f1e743b0fd))


### Fixes

* **crawler:** read social pages that robots.txt turned away before they had their own path ([c70c423](https://github.com/kapsikkum/event-scout/commit/c70c4231b96c7143967e4c65a7ef1c437cbe9e93))
* **notify:** decode entities in titles and venues, and let a test save first ([02293c6](https://github.com/kapsikkum/event-scout/commit/02293c6f5d0b7b880abdfedbbeef34a3771bf7a1))
* **notify:** keep how the room works whatever the system prompt, and answer without a name in front ([ab0ce72](https://github.com/kapsikkum/event-scout/commit/ab0ce723bd654e43b111a4f2a826fab0083aa809))
* **notify:** make Matrix chat work with several people in the room ([bd8d1c6](https://github.com/kapsikkum/event-scout/commit/bd8d1c6444722174ec4144bf5e77d767090391d5))
* **notify:** say when the Matrix bot turns an invite down ([0153cb0](https://github.com/kapsikkum/event-scout/commit/0153cb09f9bf562be5cf20ee808b1a72470d2a23))
* **notify:** send Matrix events as cards, with the flyer as an image ([0be6e74](https://github.com/kapsikkum/event-scout/commit/0be6e74c2ad53ad4f4cd1625bf9586a180b79ed7))
* **web:** tidy the Matrix bot section ([9bd03f8](https://github.com/kapsikkum/event-scout/commit/9bd03f8286779d809654b49f310d8c42ef999c41))

## [0.6.0](https://github.com/kapsikkum/event-scout/compare/v0.5.0...v0.6.0) (2026-09-11)


### Features

* **crawler:** fold and page the pages-read and calendar-feed lists ([77a0b01](https://github.com/kapsikkum/event-scout/commit/77a0b0191020605b15ef83417da753ad5b402094))
* **crawler:** skip Instagram posts too old to announce anything, and read "this Sunday" ([77a0b01](https://github.com/kapsikkum/event-scout/commit/77a0b0191020605b15ef83417da753ad5b402094))


### Fixes

* **crawler:** key a find on the event, not the page it was read on ([77a0b01](https://github.com/kapsikkum/event-scout/commit/77a0b0191020605b15ef83417da753ad5b402094))
* **dedupe:** merge one event listed under two titles at the same place and minute ([77a0b01](https://github.com/kapsikkum/event-scout/commit/77a0b0191020605b15ef83417da753ad5b402094))

## [0.5.0](https://github.com/kapsikkum/event-scout/compare/v0.4.0...v0.5.0) (2026-09-11)


### Features

* **crawler:** graph the last day of cycles, and count how often each page is read ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **crawler:** preview a calendar feed and add it to Calendar feeds ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **crawler:** read Instagram posts, and hand Facebook events to the app ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **photos:** score events for children zero, whatever the model says ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **web:** add a Recently found filter, and name the site on the crawler badge ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **web:** fold the dates of a repeating event into one card ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))


### Fixes

* **ical:** give up on a feed that has not answered in 20 seconds ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))
* **ical:** keep a feed's events until they end, not only until they start ([ddc0fc6](https://github.com/kapsikkum/event-scout/commit/ddc0fc6526d3e1744041750608077ed26070f333))


### Build and packaging

* **nix:** make the module generic, and take the deployment details out ([a4be884](https://github.com/kapsikkum/event-scout/commit/a4be884f8aac8fbee0d3ec460cf6c1d9d537ec83))

## [0.4.0](https://github.com/kapsikkum/event-scout/compare/v0.3.0...v0.4.0) (2026-09-11)


### Features

* **crawler:** crawl venue sites for events, as a separate program ([f7a5e23](https://github.com/kapsikkum/event-scout/commit/f7a5e2321d1473b05c94847077ec2ec96467964f))
* stop inventing start times, and point the crawler at chosen pages ([baf976b](https://github.com/kapsikkum/event-scout/commit/baf976bdd5e40fb76cfd120ee721acaf24a3ad2d))


### Build and packaging

* **nix:** run the crawler beside the app ([8fefb4e](https://github.com/kapsikkum/event-scout/commit/8fefb4e217329fdc0520d9c528cec01d55841ac3))

## [0.3.0](https://github.com/kapsikkum/event-scout/compare/v0.2.0...v0.3.0) (2026-09-10)


### Features

* add an API token, and patch the dependency advisories ([f047eb2](https://github.com/kapsikkum/event-scout/commit/f047eb2e4272933eba098728a8797cf72f426357))
* edit events by hand, and read the blurb as it was published ([65831d9](https://github.com/kapsikkum/event-scout/commit/65831d9732780546cd9b860f9bdbb758b6236320))
* **enrich:** summarise what the listing says, not what the card shows ([abc3c60](https://github.com/kapsikkum/event-scout/commit/abc3c60c1395bbe2919d2cab8b18301e3ddb8c6e))
* keep a copy of every flyer, filed by the date of the event ([144ad28](https://github.com/kapsikkum/event-scout/commit/144ad28e065cc5a4d6c2a839d2f7b999b96691e3))
* let other sites read the API, for the origins you name ([0dbb6bf](https://github.com/kapsikkum/event-scout/commit/0dbb6bff9ff832810643977c9dba10d29b913bf7))
* say which fields a model wrote, and let the API be queried ([d5b0a86](https://github.com/kapsikkum/event-scout/commit/d5b0a86349d1032f27a255107104fe6d4bfacf24))


### Fixes

* audit findings — SSRF guard, JSON errors, density retention ([0050e8b](https://github.com/kapsikkum/event-scout/commit/0050e8b8470a9bd528b29c4b6b7d21757567e346))
* **db:** let a column that another process just added count as added ([3e1ea98](https://github.com/kapsikkum/event-scout/commit/3e1ea98176f381c29994c3074b7618bff7133f27))
* score the events this app actually collects ([67f3145](https://github.com/kapsikkum/event-scout/commit/67f314502101ff4c1e369dd5887f352a4824fd42))
* stop handing the credentials back out of /api/settings ([0a6cc6e](https://github.com/kapsikkum/event-scout/commit/0a6cc6eef38402bee5788bb62ffe623a12736815))
* **web:** show the year on dates outside the current one ([aa29dfc](https://github.com/kapsikkum/event-scout/commit/aa29dfcea9551fa8cb9d0fc20d378175276955ce))


### Documentation

* show the app in the README ([2d7e7b8](https://github.com/kapsikkum/event-scout/commit/2d7e7b86e75413ca1f6568d52c0f3c597f1d04bc))

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
* point the deployed container at a separate Ollama host ([9400488](https://github.com/kapsikkum/event-scout/commit/9400488fcf5e232a2de586d1fe8acdde1fcd2a29))
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
