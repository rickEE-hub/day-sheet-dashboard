# Day Sheet — project memory

Public, no-login warehouse-ops dashboard for Event Equipment Group (Sydney/NSW).

- Repo: `rickEE-hub/day-sheet-dashboard`.
- Data source: Rentman (via the `Rentman` MCP server) — there is no live sync (see "Live schedule refresh — tried and reverted" below for why). As of 2026-09-08, refreshes happen automatically via two Routines (Claude Code scheduled triggers), not on-demand requests to Claude — see "Automated refresh schedule (Routines)" below.
- **Hosting is migrating from Netlify to Cloudflare Workers** (started 2026-09-02) because Netlify meters production deploys against a monthly credit allowance that a 5x/day refresh cadence burns through fast; Cloudflare Workers Builds' free tier (500 builds/month) comfortably covers that volume at $0. See "Cloudflare deploy" below for current status — until cutover is confirmed working, the Netlify site stays up as a fallback (see "Legacy: Netlify" at the bottom).

## Live architecture (Cloudflare Worker, `worker/`)

Everything under `worker/` is the current, deployed-going-forward version of the site:

- `worker/public/index.html` — team/edit page (passcode-gated writes, passcode `4242` as of 2026-09-02 — was `2866`).
- `worker/public/view.html` — contractor/read-only page.
- `worker/src/index.js` — the Worker: serves the two pages via the Assets binding and implements `/api/items`, `/api/notes`, `/api/reminder` against Workers KV (binding `DAY_SHEET_KV`, namespace id `f02d047a1e6b4cfeab61cd5e261effb0`, title `day-sheet-kv`). Request/response shapes are unchanged from the old Netlify functions.
- `worker/wrangler.toml` — Worker name `day-sheet-dashboard` (must match the Worker name Cloudflare's dashboard created during Git import — it auto-derived this from the repo name; renamed from an earlier `ee-day-sheet` to match, 2026-09-02), assets directory `./public` with `html_handling = "none"` (serves exact `/index.html` and `/view.html` paths, no auto-redirect to extensionless URLs — the Worker adds one explicit rewrite of `/` → `/index.html` so the root URL still works). KV namespace id is already filled in.

**Schedule (Rentman) data is intentionally NOT an API endpoint.** It stays baked into `worker/public/index.html` and `worker/public/view.html`'s `<script id="app-state" type="application/json">` block, exactly like the old Netlify setup — see "Baked data mechanics" below. This has been tried twice now as a live Cron-Trigger-driven KV-backed design instead (most recently 2026-09-08/09) and reverted both times — see "Live schedule refresh — tried and reverted" below for the full account. Short version: the sandbox-side blocker (no KV write, no `*.workers.dev` reach from here) is real but turned out not to be the only one — even after building the Worker to call Rentman directly (sidestepping the sandbox entirely) and getting it fully deployed, Rentman's own self-serve API tokens got a 403 "explicit deny" on `/projectfunctions`, reproduced with two different Rentman users' tokens (one Operations-role, one admin-generated). **Do not re-attempt the live-fetch design** unless Rentman support confirms self-serve API tokens can be granted access to Crew Scheduling data — check that section first, it has the exact error and what was already ruled out.

## Cloudflare deploy (Workers Builds / Git integration)

Deploys happen via Cloudflare's Git integration (their equivalent of Netlify's auto-deploy), **not** `wrangler deploy` from this sandbox — `wrangler` can run fine locally (`wrangler dev`) for testing, but `wrangler deploy`/CLI auth cannot reach `api.cloudflare.com` from here (network policy, see above).

One-time setup (a human with dashboard access must do this, not Claude):
1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Import a repository**.
2. Connect the `rickEE-hub/day-sheet-dashboard` GitHub repo.
3. Set **Root directory** to `worker` (this is a monorepo — the Worker's `wrangler.toml` lives at `worker/wrangler.toml`, not repo root). The Worker name shown in the dashboard must match `name` in that `wrangler.toml` (`day-sheet-dashboard`) or the build fails.
4. Production branch: `main`. Deploy command defaults to `npx wrangler deploy` — leave as-is.
5. Save and deploy. Every subsequent push to `main` rebuilds and redeploys automatically (free, well within the 500 builds/month tier at this project's volume).
6. The site is served at the assigned `*.workers.dev` subdomain (Rick chose the free subdomain over a custom domain on 2026-09-02) — record the final URL here once known.

Status as of 2026-09-06: **live and working** at https://day-sheet-dashboard.rick-120.workers.dev/ (team/edit) and `/view.html` (contractor read-only). Git integration deploys automatically on every push to `main`, confirmed repeatedly via `workers_get_worker_code`. Passcode `4242`.

## Live schedule refresh — tried and reverted (2026-09-08/09)

A Cron-Trigger-driven design was fully built, deployed, and then reverted within about a day. Recorded here so nobody re-derives this from scratch:

**What was built:** `worker/wrangler.toml` got a `[triggers]` cron section; `worker/src/index.js` gained a `scheduled(event, env, ctx)` handler calling `buildSchedule(env)`, a JS port of the "Rentman fetch recipe" below that hit `https://api.rentman.net` directly with `fetch()` and wrote the 14-day result to a `DAY_SHEET_KV` key, plus `GET`/`POST /api/schedule` endpoints and a "Refresh now" button on `index.html`. Timezone math (`sydneyTodayKey`/`sydneyMidnightUtcIso`/`sydneyCurrentHour`, all `Intl`-based, no hardcoded UTC+10) worked correctly across DST. All of this deployed cleanly and the `/api/schedule` routing worked.

**Why it was reverted:** every call to `https://api.rentman.net/projectfunctions` with a self-serve API token (Rentman → Settings → Configuration → Account → Integrations → API → Show token) came back `403`: `{"Message":"User is not authorized to access this resource with an explicit deny in an identity-based policy"}`. This is Rentman's own backend (AWS API-Gateway-style) rejecting the request — not a bad token format (`Authorization: Bearer <token>` was cross-checked against several independent real-world Rentman integrations on GitHub, all using the identical header). Reproduced twice: once with a token generated under Rick's own "Operations"-role account, once with a fresh token an admin generated specifically to rule out a role problem — **both got the identical error**, which means it isn't about which Rentman user made the token. Meanwhile the `Rentman` MCP server used interactively in Claude sessions (a separate, officially-integrated channel — not the self-serve token flow) reads `/projectfunctions` successfully every time. Most likely explanation: Rentman scopes self-serve "openapi"-type tokens to a subset of resources that excludes Crew Scheduling data, separate from account/role permissions — but this needs Rentman support to confirm, since the exact wording is their infrastructure's, not something guessable from outside.

**Current status:** reverted. Rick is asking Rentman support directly whether self-serve tokens can be granted this access. If they confirm yes and say what's needed, the cron design can be resurrected from this section's git history (commits from 2026-09-08 on the `claude/new-session-gonbfm` branch, PRs #1 and #2) rather than rebuilt from scratch. Until then, schedule refreshes are back to the manual "pull via Rentman MCP, bake into 4 HTML files, push" workflow below.

## Automated refresh schedule (Routines) — added 2026-09-08

Rick wants refreshes to happen on their own, weekdays only, at 7am and 5pm Sydney time — no need to ask a Claude session each time. Two Claude Code Routines (scheduled triggers) do this:

- **"Day Sheet refresh — weekday 7am Sydney"** (`trig_01FTx3VWrcmbajecAYaxddsF`) — cron `0 21 * * 0-4` (UTC).
- **"Day Sheet refresh — weekday 5pm Sydney"** (`trig_01GcqZa8GKBh6SUh114VUdcT`) — cron `0 7 * * 1-5` (UTC).

Both fire into *this specific persistent session* (`session_01UxCH8vvkTYLSRyeEscZ7gM`), not a fresh session per firing. This was a deliberate workaround, not the first choice: fresh-session-per-fire Routines need a `connectors` grant to get Rentman MCP access in the new session, and this org's plan doesn't support that parameter at all (`create_trigger` rejects it outright) — a fresh-session Routine created without it fires into a session with no MCP connector tools, which can't do anything useful here. Binding to this already-running session sidesteps that entirely, since it already holds live Rentman + GitHub access. **The real implication: these Routines only work as long as this session stays alive.** If it's ever archived/expires, recreate them (same two cron expressions, prompts describing the refresh task — see git history or ask a Claude session to reconstruct from this section) bound to whatever session replaces it, or try `connectors: ["Rentman"]` on a fresh-session Routine again in case the org's plan changes.

**Cron expressions are UTC-only — no timezone support** — the two above assume AEST (Sydney standard time, UTC+10), correct now (September). Once DST starts (~2026-10-04, first Sunday of October) Sydney moves to AEDT (UTC+11), and these will fire an hour early Sydney-time until adjusted: change the 7am trigger to `0 20 * * 0-4` and the 5pm trigger to `0 6 * * 1-5`. Revert both when DST ends (~2026-04, first Sunday of April) back to `0 21 * * 0-4` / `0 7 * * 1-5`. Use `update_trigger` with the trigger IDs above — no need to delete/recreate.

## Rentman fetch recipe (authoritative — follow exactly, every refresh)

1. Query `projectfunctions` → action `list`, filter `{"planperiod_start[gte]":"<ISO>","planperiod_start[lt]":"<ISO>","type[neq]":"shift"}`, fields `"id,name,type,planperiod_start,planperiod_end,subproject,project,amount,in_planning"`, limit 500.
2. **Mandatory filter: `in_planning === true`.** This field is the API equivalent of the "Show in planner" toggle on each function in Rentman's "Crew and transport" UI tab, and it is what actually determines whether a function shows up in the "Crew scheduling" tab. **Discard any row where `in_planning` is not `true`**, regardless of its `type` (this is not a type-based rule — e.g. a `transport_function` can have `in_planning:true` and belongs on the sheet; a `crew_function` can have `in_planning:false` and must be dropped). Confirmed by the user (2026-09-02) against Rentman UI screenshots: "You should not get the data from the 'crew and transport' tab, but yes on 'crew scheduling' only. I have the option to show in planner or not, and you should follow that!" — this is a permanent rule, not a one-off fix.
3. Resolve each unique `subproject` via `subprojects` → `get`, `expand="location,status"`. Keep only NSW jobs: `asset_location_from === "/stocklocations/1"`, and `status.id` in `{1,3,4,5,6}` (1=pending, 3=confirmed, 4=prepped, 5=onlocation, 6=returned; excludes 2=canceled, 7=inquiry, 8=concept).
4. Fetch crew via `projectcrew` — filter `{"function":"/projectfunctions/<id>"}`, expand `crewmember`, **`fields` param is required** (e.g. `"id,function,crewmember"`) or the call fails.
5. Fetch vehicles via `projectvehicles` — same pattern, expand `vehicle`, fields `"id,function,vehicle"`. Vehicle label = `vehicle.displayname + ' · ' + vehicle.licenseplate`.
6. `classify(name)` keyword categorization (keep in sync with the JS in both HTML files): priority order — test → driver → operator/forklift/scissor lift/boom lift/crane/ehs → delivery/deliver → collection/pickup/pick up/pick-up/return → packdown/pack down/pack-down/bump out/bump-out/bumpout/strike/de-rig/derig/teardown/dismantle → setup/set up/set-up/install/bump in/bump-in/bumpin/build up/build-up/rig → warehouse/restock/stocktake/stock take/prep/sorting → other. `warehouse` sits *after* install/packdown deliberately so "Warehouse Pack Down" still reads as a packdown; `operator` sits high so "Forklift Operator" isn't swallowed by another rule.

## Active manual overrides (do not overwrite from Rentman until resolved)

Rick has told us Rentman's own data for these specific jobs is wrong, and given exact replacement times to use instead — verbatim, "These are manual overrides and stay as written, even where Rentman shows something different." On every future refresh, resolve these subprojects' listed rows to the override times below, not whatever `projectfunctions` currently returns — but do still refresh their crew/vehicle assignments from Rentman normally, since only the times are disputed.

- ~~Project 1449 / subproject 1491 (LED Poster Board Hire) — AV Setup (5187) and AV Packdown (5188)~~ — **moot as of 2026-09-09.** Both were tied to early-September dates now outside the 14-day window regardless of override status; subproject 1491 doesn't appear in the Rentman pull for the current window at all. No replacement time was ever supplied for 5187 despite Rick being asked twice — don't silently reintroduce an override for either function if this job resurfaces; ask him first.
- **Project 1468 / subproject 1510 (6M x 3M LED Wall Ground Built)** — AV Packdown (function id 5248): fixed at **2026-09-09 (Wed) 11:30–14:00**, not Rentman's value (still showing 10:30–12:00 as of the 2026-09-09 refresh). **Still active — today.** (Its AV Setup, function id 5247, is NOT overridden — keep pulling that one from Rentman normally.)

These are one-off date/time corrections tied to this specific occurrence of each job, not a recurring weekday rule. Once 2026-09-09 rolls out of the visible 14-day window (i.e. once "today" passes 2026-09-09), the 5248 override above is moot too and this whole section can be deleted — check with Rick before removing it if in doubt.

## Resolving a Rentman "project number" the user gives you

Rick refers to jobs by Rentman's user-facing **project number**, which is the `number` field on the `projects` resource — **not** the internal `id`. To resolve: `mcp__Rentman__projects` → action `list` → filter `{"number": "<N>"}` (must be a **string**, not numeric — the API rejects a numeric filter value). Returns the project's internal `id`; use that to find its subproject(s) and functions.

## Baked data mechanics

- Schedule JSON lives at `<script id="app-state" type="application/json">{"items":[],"notes":{},"schedule":{"updatedAt":"...","days":{"YYYY-MM-DD":[...]}}}</script>` in both `worker/public/index.html` and `worker/public/view.html` (and, while the Netlify fallback is still live, in the root-level `index.html`/`view.html` too — keep all copies byte-identical in the `schedule` portion until the Netlify copies are retired).
- Each day bucket is an array of jobs; each job has a `rows` array of projectfunction rows (id, name, category, start, end, needed, crew, vehicles).
- After any data edit: bump `schedule.updatedAt` (ISO 8601 UTC), validate the JSON parses, `node --check` the inline `<script>` logic block, and ideally screenshot with Playwright (`/opt/pw-browsers/chromium`) to visually confirm before pushing.
- A function outside the currently-baked date window (e.g. an "AV Packdown" a couple of days after setup) is real but simply won't render until the window is refreshed to include it — note this to the user rather than silently adding it out-of-window.
- `items`/`notes` in this same JSON block are legacy/unused now that those are fetched live from `/api/items` and `/api/notes` — leave them as empty defaults (`[]`/`{}`), they're overwritten client-side on load.

## Deploy / git mechanics

- **As of 2026-09-08, both the GitHub connector's MCP tools (`mcp__github__*`) and plain `git push` from the sandbox work** — confirmed via `get_me` resolving to `rickEE-hub`, and `push_files`/`create_or_update_file`/`create_branch`/a normal `git push` all succeeding, once Rick re-approved the Claude GitHub App's permission set (GitHub had a pending re-approval banner for the installation — check https://github.com/apps/claude/installations/select_target if push/branch-creation gets a 403 again). Before that, raw `git push` hit a 403 ("Claude doesn't have GitHub access...") and creating a *new* branch via the connector hit a 403 specifically on the underlying `git/refs` creation call — pushing to an *existing* branch worked throughout. If push access ever regresses, this permission re-approval is the first thing to check, not the CCR proxy env vars below.
- Older, possibly-still-relevant fallback if the above regresses: CCR's git proxy env vars can break pushes to GitHub from this sandbox — unset them for the push:
  ```
  env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_KEY_2 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_VALUE_2 git -c http.proxy= push "https://<token>@github.com/rickEE-hub/day-sheet-dashboard.git" main:main
  ```
  Follow with `git fetch origin main` to resync the local tracking ref (pushing via an explicit URL doesn't update it automatically — expected, harmless).
- General outbound network from this sandbox is allowlist-only: GitHub, npm/pypi/etc. registries, and Anthropic infra work; arbitrary sites (`netlify.app`, `cloudflare.com`, `api.cloudflare.com`, `*.workers.dev`, `api.rentman.net`, general web) do not — `curl`/`wrangler`/`WebFetch`/etc. to those will fail with a proxy/egress rejection. MCP connector tool calls (Netlify, Cloudflare, Rentman, GitHub, etc.) are unaffected — they run through Anthropic's own MCP proxy, not this local egress path.

## Day window — 14 days (changed 2026-09-07)

The sheet started as a 3-day view, went to 5, and is now **14 days** at Rick's request. `DAY_OFFSETS` in the inline `<script id="app-script">` of all 4 HTML files is `[0..13]`. Day tabs are 14 static `.day-tab` buttons in the markup, laid out as a CSS grid — `repeat(7,1fr)` (7 across, 2 rows) on desktop, `repeat(4,1fr)` (4 across, 4 rows) at `max-width:640px`. **Every Rentman refresh must now bake 14 days of `schedule.days` keys** (today + 13), not 5, or the back half of the sheet renders as empty days.

## Categories

Nine categories: `install`, `packdown`, `delivery`, `collection`, `driver`, `warehouse`, `operator`, `test`, `other`. `warehouse` (olive `#4D7C0F`) and `operator` (deep red `#B91C1C`) were added 2026-09-07 — colors are provisional, revisit if Rick wants different ones. Adding a category means touching: the `--cat-*`/`--cat-*-soft` vars in all three colour blocks of each HTML file (light, `prefers-color-scheme` dark, explicit dark), the `.cat-*` chip class, the legend row, `CAT_LABEL` in the JS (drives the Add-item dropdown), `classify()`, and the `CATEGORIES` allowlist in both `worker/src/index.js` and `netlify/functions/items.mts` (the Worker silently coerces unknown categories to `other`). Unlike the original 7, Warehouse and Operator **do** have Rentman-keyword auto-classification — see the `classify()` entry above.

## Branding

The masthead h1 reads **"Daily Schedule"** (renamed from "Day Sheet" 2026-09-07; the project, repo and Worker keep the day-sheet name). Empty-state text reads "No jobs or tasks for X" (was "No jobs or manual items for X"). The Event Equipment "AUDIO VISUAL" logo (red play-button + wordmark) renders top-right on both pages: background removed (distance-from-white alpha ramp, no white halo), cropped, resized to 100px height, re-encoded as WebP, and embedded **inline** as a `data:image/webp;base64,...` `<img class="logo">` — no external hosting (`/logo.png` was tried first by another pass at this change and doesn't work, since Cloudflare's Assets binding only serves files actually committed to `worker/public/`, and none was; inline data-URI is the only approach consistent with this project's fully self-contained-HTML architecture — don't reintroduce an external logo path). It sits inside a `.logo-bar` div (`display:flex; justify-content:flex-end;`) that is the very first child of `.wrap`, above the reminder banner and masthead — this renders as top-right regardless of the masthead's own wrap behavior. Do **not** position the logo with `position:absolute` relative to `.wrap` either — tried and reverted, it overlapped the snapshot badge on `view.html` (whose masthead-right never wraps, unlike `index.html`'s, which does wrap under the title at normal desktop widths because the eyebrow text + badge/buttons don't both fit above ~1400px — pre-existing layout behavior, not a regression). The `.logo-bar` row sidesteps that by reserving its own dedicated space.

## Theme

Nordic Clean theme, light by default. `<html lang="en" data-theme="light">` is hardcoded on both pages so the site never falls back to a visitor's OS/browser dark-mode preference — this was a bug fixed on 2026-09-02 and must not regress.

## Legacy: Netlify (being retired)

Kept in place only as a fallback until the Cloudflare cutover is confirmed. Do not make new feature changes here — mirror any real fix into `worker/public/*.html` too, or better, treat `worker/` as the sole source of truth going forward.

- Team/edit link: https://ee-timeline.netlify.app/ · Contractor/read-only: https://ee-timeline.netlify.app/view.html
- Netlify site `ee-timeline`, auto-deploys on push to `main` — except production deploys were paused 2026-09-02 when the team's Netlify build-credit allowance ran out for the billing cycle (this is *why* the Cloudflare migration happened).
- `netlify/functions/{items,notes,reminder}.mts` — same three endpoints as the Worker, backed by `@netlify/blobs` instead of KV.
- Once Cloudflare is confirmed working and Rick has the new URL in hand, this whole Netlify path (root-level `index.html`/`view.html`, `netlify/` directory, the Netlify site itself) can be deleted/decommissioned — ask before doing so.
