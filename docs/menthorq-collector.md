# MenthorQ collection for GEX Gravity

Destination: your own authenticated, private GEX Gravity deployment.

The current Windows workflow checks the private site's saved status and alerts when the levels are missing. Keep the browser reader paused until MenthorQ authorizes automated access in writing under its [terms](https://menthorq.com/legal/terms-of-use/). When authorized, use the procedure below and keep authentication in the browser.

## Schedule

Use `America/New_York` for all time decisions, including DST. Monday through Friday, the local collector checks Levels and Net GEX every five minutes and Net DEX every 15 minutes from 09:30 through 16:00 inclusive. The EOD slot is at 23:30 on weekdays. Saturday and Sunday are skipped. An ordinary timeout waits for the next scheduled slot. Keep the original source dates and timestamps. Do not replay missed slots or repeat a completed EOD capture.

An authorized 0DTE import uses **Options → Exposure → Intraday → Net GEX**
and only the expiration card whose date is today in New York. In GEX Gravity,
use **Data & settings → Import 0DTE Net GEX** to add the displayed signed values
for watched strikes. The exact contract link, expiry date and independent
check time are required. The import preserves the Levels and all-expiry
exposure already saved for that contract.

## Read and capture

1. Read GEX Gravity's `get_market_watch` tool. Use the exact selected dated futures for NQ, ES and CL, not a cash index, continuous future or another month. `watchContext` contains the last saved provider and capture evidence. If this EOD day's successful EOD capture is already present for a market, skip that market.
2. Use the existing MenthorQ tab with `cua_repl`. Navigate through the observed Levels link and choose Paste Tickers. Choose Gamma Levels Intraday or Gamma Levels EOD for the scheduled mode. Search one exact provider symbol at a time, such as NQZ2026. A multi-symbol export can use the oldest available date in the group. For each symbol, use the latest available date (Next Date disabled), read the displayed provider date and time, and copy the export. If the clipboard is empty, read the visible export directly from the DOM. If that contract's source date is older than the saved context, keep its saved map and continue with the other contracts.
3. For each matching future, use the symbol selector and Options > Exposure. Verify the exact dated symbol, Net GEX, the appropriate Intraday/EOD mode and All Expirations. Capture both the displayed aggregate total and the displayed strike-by-strike values for the watched levels, including their K/M/B suffixes. Scroll the chart to the watched strike when necessary and verify the strike/value pairing from the same row. Record only values actually shown; omitted strikes are unavailable, not zero. Do not infer numbers from bar lengths, GEX ranks or call/put OI subtraction.
   - Read any displayed source date/time and Delayed badge independently for Exposure. The Exposure screen and Levels export can have different timestamps; do not borrow the Levels date or time for the exposure total or strike rows. A capture time is not a source time. If no source date/time is shown, keep those fields null.
   - Keep `Net GEX` and `Absolute GEX` distinct. Net GEX is signed net exposure. Taking its absolute value for planet sizing does not turn it into the provider's Absolute GEX metric, which does not net positive and negative gamma. Preserve the selected metric identity. Keep the provider display scale; do not assume the futures denominator is per point or per 1% move, and do not convert these values into Futu hedge contracts without a verified calibration.
4. Build contexts with `parseMenthorqExport` in `core/menthorq-import.mjs` from this checkout. Preserve mode, sourceDate, sourceLocalTime, exact contract and source URL. The exported time currently has no verified timezone, so `asOf` remains null unless the provider explicitly supplies one. Add `delayStatus:'delayed'` when the actual provider badge says Delayed. Add `regime:{netGex,display,scope:'all-expiries',mode,sourceDate,asOf,sourceUrl,delayStatus}` only from the independently observed aggregate Exposure screen; if the total cannot be read, set regime to null.
5. Add the independently captured strike snapshot as `exposure:{metric:'Net GEX',scope:'all-expiries',mode,sourceDate,asOf,sourceUrl,delayStatus,capturedAt,rows:[{strike,display}]}`. Use `metric:'Absolute GEX'` only when that metric was actually selected and read. Its mode/date/clock can differ from the Levels map and must retain their own evidence. `display` is the authoritative provider number; the server parses K/M/B and ignores any separately supplied `value`. The server retains only imported watched strikes, with at most 80 rows. Do not copy these independently timed values into `levels[].gex`; that would falsely give them the Levels map's clock and scope. Missing dates/times stay null. A new Levels capture with no new strike Exposure capture must use `exposure:null`, and must not carry old exposure or heatmaps forward as fresh.

## Save and verify

Prefer the connected GEX Gravity `save_menthorq_context` tool, passing `{market,context}`. If its new tool is not exposed yet, use the site's existing MenthorQ import UI: select the matching market, expand the MenthorQ map editor, choose the JSON import, paste the validated context and save. Never use a browser evaluate call to issue a request or mutate app state.

Read `get_market_watch` again and check the exact source date, mode, levels, aggregate regime and independent `exposure` for every saved market. Compare captured row strikes and display strings, metric, scope, coverage and separately unknown source clocks. A saved capture proves only that the source was checked; it does not establish the source clock or eliminate a provider delay. Retain browser access for later runs with the documented handoff mark. Update data only: do not rebuild or republish the site each run. Avoid overlapping runs. If sign-in or an approval is required, stop the dependent work and tell the user what is blocked. Never label a skipped/failed capture successful.

Successful context saves also append a private server archive automatically.
No additional provider request or collector write is needed for that backup.
An archive failure must remain a failed save and be retried within the permitted
window. Historical recovery is a separate owner-requested operation; it must
not replace the current map or change its source/capture timestamps. See
`data-backups.md` for listing and download operations.

Source code lives in this checkout.
Keep temporary captures outside the checkout. Commit synthetic fixtures only.
