# shared

Rules the server and the crawler both need: what a date means, how long an
event is believed, how far out an area reaches, which schema.org types are
events, and reading a date or a town out of a caption. They are separate
programs that build and ship on their own, so this directory exists twice,
identically, as `server/src/shared` and `crawler/src/shared`.
`server/test/shared.test.ts` fails when the two differ.

Change a file here, then copy it across:

    cp server/src/shared/* crawler/src/shared/
