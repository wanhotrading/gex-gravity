# GEX Gravity quote updates

Current operation: the user chose 15-minute updates while the page is open.
Closing the page stops these updates; background-tab timers can be delayed.
No unattended cloud schedule is active. Sites rejected a 15-minute schedule
because its cloud tasks are limited to one run per hour. Do not create an
hourly schedule unless the user changes this preference.

The private Site stores the Futu quote-only connection encrypted in its private
R2 bucket. OAuth access and refresh tokens never appear in source, frontend
responses, task prompts, or logs. Futu may require renewed user authorization
when the refresh token expires. Only quote:read is accepted; trading access and
wildcard account tags are rejected in granted tokens.

Use the connected GEX Gravity `refresh_market_watch` tool to refresh NQ, ES and
CL once per quarter-hour slot. Then use `get_market_watch` to verify the stored
snapshot and timestamps. These operations update persistent data without a new
deployment. The update method preserves the last valid market snapshot when a
new attempt fails. Check each market's status, quote timestamp, expiry-range
coverage and missing-field counts. Successful scheduling alone is not proof of
successful Futu quote access.

When the linked tools are not exposed in a task, use supported private Site
service access instead. Read this Site with Sites `get_site`, retaining its
`siwc_bypass_bearer_token` only in memory. Send it to this exact Site only as
`OAI-Sites-Authorization: Bearer <value>`. POST `/api/refresh?view=summary` with JSON `{}`,
`Content-Type: application/json` and `Origin` equal to the Site origin. Then GET
`/api/market-state?view=summary` and check the persisted result. Never print or
save the bearer, put it in a URL, follow redirects with it, or send it to Futu.
This private-HTTP service credential does not authenticate the separate `/mcp`
OAuth resource. Retrieve fresh supported service access on each task run.

Each refresh request performs a bounded collection step and persists its cursor.
While `refreshInProgress` is true, repeat the same request, respecting any
`refreshProgress.retryAfterMs`, until complete (at most 60 steps per run). Keep
the same job when retrying a transient timeout; do not force a restart. The
ordinary `{}` request is idempotent within each quarter-hour slot. A deliberate
manual refresh can send `{"force":true}`. Each market retains its prior snapshot
until its new planned collection finishes. A saved schedule is not evidence of
data freshness: inspect final coverage, errors, timestamps and readback.

The initial expiry horizon is 45 calendar days for the selected, exact futures
month in each market. It is not a complete all-expiry or all-month GEX universe.
Metadata is cached for six hours and expiry ranges are fetched in windows of at
most 14 calendar days, avoiding the provider's 20-expiry limit. Quote snapshots
are fetched in batches of at most 400 codes after a small native-Greek probe.
All quote calls share a serial rate limiter. A missing or failed probe leaves
the dynamic fields unavailable rather than triggering a large blind collection.

Automatic futures-month selection uses a unique highest-volume leader among
provider-listed, nonexpired contracts with recent snapshots. No month is guessed
from the calendar. An ambiguous selection needs an explicit listed-month choice.

The dashboard separates reported Greeks from modeled Black-76 scenarios.
Unsigned open interest does not identify dealer inventory. Long/short inventory
choices are hypothetical position assumptions. Price and IV changes hold time and
positions fixed; their hedge deltas are model-to-model changes, not observed trades.
Current Delta exposure and Gamma concentration display their row coverage.
Different underlying futures contracts are not combined into one hedge count.

Only individually verified CME NQ/ES weekly families get automatic expiry times.
Recognized CL families have verified exercise styles and standard contract size,
but their precise expiry clock remains unresolved. Other families need verified
inputs. American-style options require an explicit
European approximation. The model has a positive-price domain and is not valid
for zero or negative crude-oil prices. A fading Gamma region does not predict a
reversal or its size.

Scheduled runs should remain quiet on unchanged, healthy results. Report an
actionable authorization failure, missing entitlement, prolonged stale data or a
material coverage failure. Never purchase a data card or expand quote permissions.

## Focused MenthorQ and Futu workspace

The server stores an owner-private MenthorQ watch context separately from Futu's
full chain and OAuth connection. Only exact dated-contract watch strikes appear
in the mirrored Call / Strike / Put table. Continuous contracts, cash-index levels
and nearby strikes are never silently substituted. Source date, source timestamp
and capture timestamp remain separate. A missing exact source clock makes the
context visibly stale; it does not turn the capture time into market time.

`POST /api/watch-context` imports `{market,context}`; GET reads `{contexts}`.
The primary browser import accepts MenthorQ's copied level text, source date,
optional unzoned displayed time and EOD/Intraday mode. Advanced JSON accepts a
structured capture with heatmap cells. No unattended MenthorQ
API connection is claimed. Captured heatmap cells retain metric and expiry,
including Net GEX, Net DEX, OI and IV x OI. Missing cells are unavailable; IV x OI
is not ordinary contract IV. Browser-captured paid-source data stays in private
runtime storage and is not included in the source repository.

While visible, the selected market checks watched nonexpired option series every
60 seconds through `/api/iv-refresh`, at most 399 options plus the exact future.
The server independently validates the saved watch strikes and contracts, applies
a 60-second cooldown and shares the full collector's lease. Larger sets rotate
through bounded batches. Fifteen-minute full-chain refresh remains page-open.
IV history and previous/baseline comparisons persist in private runtime storage;
differences use volatility percentage points. Equal or older quote timestamps
never create a fresh dated IV observation. Futu does not expose a separate IV,
Greek or OI calculation timestamp, and the subscription may deliver delayed quotes.

Verified dated-contract Futu snapshot Greeks use documented underlying-price
units. They support conditional current hedge arithmetic without an invented
expiry clock when the owner, quote timestamp and nonexpired calendar metadata
pass validation. CL therefore shows reported IV/Delta/Gamma/OI and conditional
hedges while exact-time fade/scenarios remain unavailable without a verified
expiry clock. Hypothetical OI inventories are never called actual dealer holdings.
