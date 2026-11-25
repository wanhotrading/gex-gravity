# GEX Gravity

A futures-options dashboard for NQ, ES and CL, with a manual calculator that also supports GC. The local preview supports the manual workflow. A hosted installation that handles provider or archive data requires owner-only authentication and its own provider access.

Market Watch uses an authorized quote-only Futu connection. Watched option snapshots refresh every 5 minutes while the page is open; selected watched-series IV checks run at most once per minute while visible. MenthorQ watched levels are imported separately. Credentials and licensed runtime data stay out of source control. The manual snapshot workflow remains available.

Select a strike curve, planet or watchlist row to reveal its **Delta transition range** on the main chart. Choose one eligible call/put and exact expiry, then 0.05/0.95 or 0.01/0.99 delta magnitudes. Markers show theoretical price crossings and signed distances from the saved futures price; the underlying strike curve still combines the selected eligible series. Inputs use the snapshot clock and explicit IV/time scenarios, with quote-clock limitations displayed. Missing/expired inputs withhold endpoints. Crossings do not establish completed dealer hedging or predict reversals.

## Session hedge flow

Choose a +/- price move, hypothetical dealer inventory and assumed share of the selected OI. The panel reports the modeled option Delta change, existing/target futures hedge, net buying/selling, long additions/reductions and short additions/covers. It covers watched strikes, the selected expiry filter and verified contract point values only. Unsigned OI does not reveal actual dealer positions.

Where exact expiry and model inputs are available, both endpoints are repriced using the same snapshot time/IV. Otherwise, a separate current-Gamma approximation is available only for moves within five Delta points per series and valid call/put Delta bounds. It does not model Gamma fade or invent a CL expiry clock.

Historical references use unadjusted five-minute bars for the exact dated future. The seven NY windows cover 09:30–16:00, including the explicit 10:30–11:00 gap. Only completed prior NY dates with every bar in a window are admitted; the last 20 complete observations per window are retained. Collection uses explicit batches of at most two calendar dates to avoid the provider's observed 1,000-bar truncation and inaccurate paging flag. It is bounded to 40 pages and 60 calendar days, cached privately and resumed while the page is open. Actual coverage and sample counts are displayed. Bar start/end convention is inferred from at least two agreeing CME maintenance-pause observations; contract-volume units require corroboration against turnover and the verified contract point value, or a complete current trading-day bar sum bracketed by two exact-futures snapshot volumes.

Volume participation is abs(net hypothetical futures change) / median historical window volume. Optional point pressure uses an explicitly assumed factor Y × historical window volatility × volatility multiplier × sign(net hedge change) × sqrt(participation). Historical volatility is sqrt(sum of five-minute close-to-close point changes squared), starting from the first bar's open. At least 10 complete observations are required for the stress figure; orders exceeding typical whole-window volume are excluded. Verified contract units are used by default. If the provider's units cannot be corroborated, an explicit, default-off control can treat reported native futures volume as contract counts. Such output is labeled contracts-assumed and remains an assumption, not verified volume. The Y = 1 example is an illustrative stress assumption, not a fitted dealer-impact coefficient. OHLCV cannot identify actual dealer trades, their execution, or the fraction of a price move they caused. The stress figure is not added to the conditioning price move.

## Morning plan and arrival readings

1. At 09:45 New York time, choose the market and select **Save morning GEX**. Enter the exact underlying futures contract, observed futures price, source time, source units and the strikes you want to watch. Paste one `strike,signed GEX` pair per line, without thousands separators; K/M/B suffixes are accepted.
2. Levels are ranked by absolute GEX. Include neighboring strikes if you want to inspect a cluster. The net total covers only the supplied watchlist, not the entire market. The app does not automatically detect a price touch or recalculate the morning GEX.
3. When price reaches a watched strike, select **Update chain reading**. Enter the fresh futures price and time, call/put and that exact option's IV in percent, such as `42.06`. Displayed Delta, Gamma and OI are optional; blank means unknown, while zero remains zero. The exact expiry time and exercise style are needed for the modeled fade curve. Confirm these for the selected series; do not guess an expiry hour from its date.
4. The arrival reading is stored under that strike, separately from the original GEX, price, timestamp and source. Other strikes remain unchanged. The model uses the saved reading's time and IV, not the clock. A new reading replaces that strike's previous reading and cannot precede the morning plan or the prior reading.
5. Watchlists and readings are saved in this browser's local storage, with no cloud synchronization. **Export watchlist** downloads a JSON backup; **Import JSON** restores it. Saving another morning plan replaces that market's current plan and readings. Clearing the view preserves the separate GEX observation history. Storage errors are shown explicitly.

New York date/time inputs account for daylight saving time. Nonexistent spring minutes and ambiguous fall minutes are rejected rather than guessed. A single series' gamma-fade percentage is never applied to the aggregate GEX bar or cluster. Actual dealer inventory, hedge orders and reversal strength cannot be recovered from these readings alone.

## Run and rebuild

Use Node.js 20 or later. There are no external dependencies or installation step.

```text
npm test
npm run build
npm run validate
npm run preview
```

Open `http://127.0.0.1:4317` after starting the preview. Hosting settings for a new private deployment go in your local deployment configuration, using `.openai/hosting.json` as a template. The preview runs with no feed credentials. The complete source must contain `frontend/index.html`, `frontend/styles.css`, `frontend/app.mjs`, `core/engine.mjs`, `src/server-core.mjs` and `.openai/hosting.json`.

Edit `frontend/`, `core/engine.mjs` and `src/server-core.mjs`. The build embeds all required browser assets into `worker/index.js` and writes the same generated module to `dist/server/index.js`, alongside `dist/.openai/hosting.json`. It does not depend on neighboring project folders. `scripts/build.sh` is an optional wrapper for the same build.

## What the calculations mean

- Model inputs must identify **one option series**: exact underlying futures contract, strike, option type, expiry with a UTC offset, IV and exercise style. A strike aggregated across expirations is not a single-series input. Do not apply one IV and expiry to an aggregate GEX bar and present it as an exact portfolio calculation.
- IV is a decimal: `0.20` means 20%. Time is exact remaining calendar time on an ACT/365 basis. The rate defaults to zero unless supplied. Prices and strikes use native futures points; multipliers must be supplied in currency per point when sizing hypothetical hedges.
- Delta and Gamma use European Black-76. An American-style option is rejected unless `allowEuropeanApproximation` is explicitly enabled; results then remain labeled as an approximation. Select the actual series' exercise style rather than guessing from NQ, ES, CL or GC alone.
- The price profile holds **current IV and remaining time constant**. The 50%, 25% and 10% levels describe Gamma remaining relative to that fixed strike's modeled Gamma peak. They are sensitivity comparisons, not forecast probabilities, price targets or guaranteed reversal levels.
- A hypothetical hedge for **100 contracts**, where shown, is an illustrative assumed position. It does not estimate actual dealer inventory, executable orders, liquidity or market impact. Negative GEX alone does not prove dealers are short those puts.
- Morning-plan history is stored in the browser. Targeted Futu IV checks persist bounded previous/baseline observations in private runtime storage while the visible page requests updates. This is not a recovered exchange history or an unattended recorder.

Formula reference: [Black-76 Greek formulas](https://carlolepelaars.github.io/blackscholes/4.the_greeks_black76/).

## Optional server-side feed relay

The server accepts a **generic normalized snapshot endpoint**. It is not an adapter for IBKR, Databento, a broker or any named data vendor. A separate adapter must obtain entitled source data, identify exact contracts and timestamps, document GEX units and position assumptions, and transform the response into the schema in `examples/snapshot.example.json`.

Configure these server environment values only after that adapter exists:

| Variable | Meaning |
| --- | --- |
| `GAMMA_FEED_URL` | Public HTTPS endpoint returning the normalized snapshot schema. The server appends `market=NQ`, `ES`, `CL` or `GC`. |
| `GAMMA_FEED_TOKEN` | Optional server-only bearer token for the adapter; never put it in browser files or imported JSON. |
| `GAMMA_FEED_PROVIDER` | Display name for the configured source. |

`GET /api/status` reports whether a relay endpoint is configured; configuration alone does not establish a successful live connection. `GET /api/snapshot?market=NQ` fetches, validates and returns a normalized snapshot. With no configured endpoint it returns `FEED_NOT_CONFIGURED`. The relay uses a 10-second timeout, a 2 MiB response limit, no browser caching and no redirects. Source classifications such as delayed or frozen are preserved; quotes labeled live but older than two minutes become stale. An advancing source timestamp is still required for a useful real-time display.

The example is synthetic, static and intentionally labeled `snapshot`. Its quantities must never be shown as a live quote or verified dealer position. Feed credentials are not part of this source package.
