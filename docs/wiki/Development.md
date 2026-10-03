Needs Node.js 22 or newer and nothing else. Run the tests with:

```sh
npm test
```

After adding a route, give it the `op` name from the official spec and run `npm run docs` to update ENDPOINTS.md. A new `PUT` or `POST` route also needs its request schema: `npm run schemas` copies them from the spec into `src/schemas.json`. `npm run check-spec` downloads the [Meraki OpenAPI spec](https://github.com/meraki/openapi) and reports routes whose path or operation ID don't match it, plus response fields the spec's examples have that ours don't. Fields the real API only sends in situations the emulator doesn't have (cellular uplinks, templates, adaptive policy and so on) are listed in `CONDITIONAL` in the script and left out of the report; `-- --all` shows them too. Pass a path to use a local copy of `spec3.json` instead.

Endpoints that report traffic should total it with `clientUsage`, `clientsUsage` or `networkTotals` from `src/sim/usage.js`. They keep daily totals per client, plus hourly totals for days a window only partly covers (up to 40 days, enough for per-day histories split at local midnight). Walking `eachSlot` directly costs time in proportion to the window and the number of clients. `npm run bench` times every sample URL and the longest timespan each route accepts, so run it after adding an endpoint to catch a slow one.

`npm run fuzz` sends broken bodies to every write route and junk query values to every GET, reads every sample URL after each write route's bodies, and fails on any `5xx`. A `PUT` starts from what its `GET` answers, so each body has one broken field. It takes about five minutes, and CI runs it on every pull request. `--only <regex>` limits it to matching operation IDs.

## The wiki

These pages live in `docs/wiki/` in the repository, one Markdown file per page, and change through pull requests like any other file. When one merges, the Wiki workflow copies the folder to the wiki and replaces what was there, so edits made on the wiki itself are lost on the next run. Link to another page by its file name without `.md`, as in `[Writes](Writes)`. `npm test` checks that every such link names a page in the folder.
