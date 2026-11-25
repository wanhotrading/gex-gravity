# Local software collection

The Windows collector runs ordinary Node.js code and uses the private hosted
Futu collection engine. It never calls a language model. Futu collection runs
from Monday 00:00 through Friday 17:00 New York, with a Monday–Thursday
17:00–18:00 pause. Exchange holiday overrides require separate calendar
verification; a successful request does not establish a fresh source quote.

Runtime state and DPAPI-encrypted Site service access belong outside the source
checkout in `../gex-gravity-collector`. Provider credentials stay in their
existing stores. Source code, logs and task arguments must contain no tokens.

## Dedicated MenthorQ browser

`browser-plan.json` describes the user-approved browser setup. It uses a new,
dedicated Chrome profile and a debugging port bound to `127.0.0.1:9337`.
This lets ordinary local software read the signed-in dashboard. Other processes
that can reach that port could also control that dedicated profile. It does not
use or copy the user's ordinary Chrome profile or the agent browser's session.

Approve this access method for your installation and sign in directly to the dedicated profile. The supervisor verifies the port binding and dedicated profile before
each browser collection and can reopen that same profile after Chrome exits.
Session expiry or a CAPTCHA must stop dependent collection and report attention
required. A saved browser login is not a verified unattended collector.

The minute Windows Task Scheduler heartbeat uses `IgnoreNew` and a local process
lock; the private service also leases provider jobs. Five-minute slots are
idempotent. Missed runs resume at the next available heartbeat. The task uses the
same Windows user and requires a signed-in, awake computer; it does not change
power settings or store a Windows password.

The task starts through Windows' GUI script host, `task-run.vbs`, which launches
the same Node collector with window style 0 and waits for its exit code. This
avoids the initial flashing PowerShell console while preserving task overlap
protection, the existing credentials and the collection schedule.

Site access is stored only as Windows current-user DPAPI ciphertext. Futu OAuth
stays encrypted in the private hosted service. Browser authentication stays in
the dedicated Chrome profile. No provider authentication is exported. A local
status heartbeat is distinct from successful, timestamped provider observations.

MenthorQ collection defaults to disabled. After written authorization, the
runtime config must explicitly enable it and specify either `exposure-map`
or `levels-and-exposure`. The first scope reads the approved Exposure Map
and uses existing saved watched strikes. The second also imports Levels for
the exact NQ, ES and CL futures selected on the site. Use the scope covered by
the provider's authorization, while the subscription remains active.

The reader captures all-expirations Net GEX and Net DEX on the same
Exposure Map, with separate rows, totals and capture times. It saves
Net GEX before switching to Net DEX. An unavailable Net DEX reading
leaves the last saved Net DEX observation and the new Net GEX intact.
A transient site upload error triggers a readback and, if the capture is
missing and time remains, a retry of that same capture. A busy save backs
off between retries within the current market's time budget. Busy Exposure
saves get a final readback and retry after the other markets, within the same
slot and using the original observation. An isolated
intraday write conflict stays in the run log. Windows alerts if saved Levels
or GEX exceed 15 minutes, or DEX exceeds 30 minutes, during that conflict.
It repeats that overdue alert at most once every 30 minutes. The collector
keeps later markets in the run when an individual browser page times out.
If Playwright times out while attaching to the dedicated Chrome profile,
the collector checks which idle MenthorQ tabs respond. It wakes a stalled
tab and retries the connection once under the existing run lock. A second
attach timeout reports `MQ_BROWSER_ATTACH_TIMEOUT`.
A missing provider source clock stays unknown. Unchanged or unavailable Levels are
retained without advancing their original capture time. Access challenges
stop the dependent collection and require the user to address the provider
page. No authentication challenge is bypassed.

The collector checks Levels and Net GEX every five minutes from 09:30 through
16:00 New York on weekdays. It checks Net DEX once per market each quarter-hour.
If a market misses that check, the next five-minute run retries it within the
same quarter-hour without re-reading a market that already saved. Both
metrics are due in the weekday 23:30 EOD slot. Each slot allows one attempt.
The collector skips both providers on Saturday and Sunday in New York.
An ordinary timeout waits for the next scheduled slot. Login and access
challenges wait 30 minutes. The last
failure persists across heartbeat-only runs. Windows alerts the signed-in
account when a check is overdue or an update is incomplete. A paused feed
keeps its manual-import reminder.

`node collector/run.mjs --capture-menthorq-once` makes one deliberate
weekday Intraday capture under the configured scope. It uses the same lock and
cooldown as the scheduled task and skips Futu.

Every top-level task failure is recorded in runs.ndjson with a bounded error
code. State-file replacement is atomic. Neither logs nor site status contain
credentials or provider response bodies.

## Configure the collector

Set `GAMMA_SITE_ORIGIN` to your private hosted origin, then run `node collector/setup-local.mjs`. Supply the existing service-access bearer for your own deployment through the hidden prompt. Run the task installer only after reviewing the generated runtime configuration and the dedicated browser settings.
