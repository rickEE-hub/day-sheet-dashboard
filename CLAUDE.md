# Day Sheet — project memory

Public, no-login warehouse-ops dashboard for Event Equipment Group (Sydney/NSW).

- Team/edit link: https://ee-timeline.netlify.app/ (index.html, passcode-gated writes, passcode `2866`)
- Contractor/read-only link: https://ee-timeline.netlify.app/view.html
- Repo: `rickEE-hub/day-sheet-dashboard`, Netlify site `ee-timeline`, auto-deploy on push to `main`.
- Data source: Rentman (via the `Rentman` MCP server), pulled manually per refresh — there is no live sync. Schedule data is baked into `<script id="app-state" type="application/json">` in both `index.html` and `view.html`.

## Rentman fetch recipe (authoritative — follow exactly, every refresh)

1. Query `projectfunctions` → action `list`, filter `{"planperiod_start[gte]":"<ISO>","planperiod_start[lt]":"<ISO>","type[neq]":"shift"}`, fields `"id,name,type,planperiod_start,planperiod_end,subproject,project,amount,in_planning"`, limit 500.
2. **Mandatory filter: `in_planning === true`.** This field is the API equivalent of the "Show in planner" toggle on each function in Rentman's "Crew and transport" UI tab, and it is what actually determines whether a function shows up in the "Crew scheduling" tab. **Discard any row where `in_planning` is not `true`**, regardless of its `type` (this is not a type-based rule — e.g. a `transport_function` can have `in_planning:true` and belongs on the sheet; a `crew_function` can have `in_planning:false` and must be dropped). Confirmed by the user (2026-09-02) against Rentman UI screenshots: "You should not get the data from the 'crew and transport' tab, but yes on 'crew scheduling' only. I have the option to show in planner or not, and you should follow that!" — this is a permanent rule, not a one-off fix.
3. Resolve each unique `subproject` via `subprojects` → `get`, `expand="location,status"`. Keep only NSW jobs: `asset_location_from === "/stocklocations/1"`, and `status.id` in `{1,3,4,5,6}` (1=pending, 3=confirmed, 4=prepped, 5=onlocation, 6=returned; excludes 2=canceled, 7=inquiry, 8=concept).
4. Fetch crew via `projectcrew` — filter `{"function":"/projectfunctions/<id>"}`, expand `crewmember`, **`fields` param is required** (e.g. `"id,function,crewmember"`) or the call fails.
5. Fetch vehicles via `projectvehicles` — same pattern, expand `vehicle`, fields `"id,function,vehicle"`. Vehicle label = `vehicle.displayname + ' · ' + vehicle.licenseplate`.
6. `classify(name)` keyword categorization (keep in sync with the JS in both HTML files): priority order — test → driver → delivery/deliver → collection/pickup/pick up/pick-up/return → packdown/pack down/pack-down/bump out/bump-out/bumpout/strike/de-rig/derig/teardown/dismantle → setup/set up/set-up/install/bump in/bump-in/bumpin/build up/build-up/rig → other.

## Resolving a Rentman "project number" the user gives you

Rick refers to jobs by Rentman's user-facing **project number**, which is the `number` field on the `projects` resource — **not** the internal `id`. To resolve: `mcp__Rentman__projects` → action `list` → filter `{"number": "<N>"}` (must be a **string**, not numeric — the API rejects a numeric filter value). Returns the project's internal `id`; use that to find its subproject(s) and functions.

## Baked data mechanics

- Schedule JSON lives at `<script id="app-state" type="application/json">{"items":[],"notes":{},"schedule":{"updatedAt":"...","days":{"YYYY-MM-DD":[...]}}}</script>` in both `index.html` and `view.html` — keep them byte-identical in the `schedule` portion.
- Each day bucket is an array of jobs; each job has a `rows` array of projectfunction rows (id, name, category, start, end, needed, crew, vehicles).
- After any data edit: bump `schedule.updatedAt` (ISO 8601 UTC), validate the JSON parses, `node --check` the inline `<script>` logic block, and ideally screenshot with Playwright (`/opt/pw-browsers/chromium`) to visually confirm before pushing.
- A function outside the currently-baked date window (e.g. an "AV Packdown" a couple of days after setup) is real but simply won't render until the window is refreshed to include it — note this to the user rather than silently adding it out-of-window.

## Netlify functions (`netlify/functions/*.mts`)

- `items.mts` → `/api/items` — manual (non-Rentman) schedule items. GET open; POST/PUT/DELETE require header `x-day-sheet-passcode: 2866`.
- `notes.mts` → `/api/notes` — notes keyed by row id. Same auth pattern.
- `reminder.mts` → `/api/reminder` — single optional banner. Same auth pattern.
- All three use `@netlify/blobs` for storage.

## Deploy / git mechanics

- CCR's git proxy env vars break pushes to GitHub from this sandbox — unset them for the push:
  ```
  env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_KEY_2 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_VALUE_2 git -c http.proxy= push "https://<token>@github.com/rickEE-hub/day-sheet-dashboard.git" main:main
  ```
  Follow with `git fetch origin main` to resync the local tracking ref (pushing via an explicit URL doesn't update it automatically — expected, harmless).
- Netlify auto-deploys on push to `main`.

## Theme

Nordic Clean theme, light by default. `<html lang="en" data-theme="light">` is hardcoded on both pages so the site never falls back to a visitor's OS/browser dark-mode preference — this was a bug fixed on 2026-09-02 and must not regress.
