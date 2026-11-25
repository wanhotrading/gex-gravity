# Gravity visualization: evidence and limits

Reviewed November 7, 2026. The planets are an explanatory analogy, not a gravitational pricing model. No empirical probability is fitted or displayed.

## 0DTE follow-up — November 7, 2026

0DTE merits a distinct label, not an automatic mass multiplier. The implementation now distinguishes MenthorQ's provider landmark from a Futu contract with a verified active expiry on the model snapshot's New York calendar date. The provider guide describes its 0DTE wall scope as within 24 hours; that can differ from same-day expiry. A 0–5 DTE summary is not pure 0DTE. Exact clocks remain product-specific; no new universal settlement time is assumed. [MenthorQ definitions](https://menthorq.com/guide/key-levels-and-key-terms/), [expiry selection](https://menthorq.com/guide/options-menu/).

The current saved strike exposure is all-expiry Net GEX. It determines planet area/score even when the user isolates a Futu expiry subset. A badge cannot identify the 0DTE fraction of that exposure. Actual expiry-specific provider exposure would require a separately dated capture of the exact expiry and matching future. The all-expiry dealer gamma sign is also withheld from automatic subset direction; manual signs remain scenarios.

### Measurement

For European futures options, Black-76 gamma is `exp(-r*tau)*phi(d1)/(F*sigma*sqrt(tau))`, with `d1=(ln(F/K)+0.5*sigma^2*tau)/(sigma*sqrt(tau))`. Near the money its peak grows and width contracts as time runs down; sufficiently far from the money it can collapse. There is no universal faster-decaying 0DTE curve. Eligible American contracts continue using the existing American futures model. [CME gamma](https://www.cmegroup.com/education/courses/option-greeks/options-gamma-the-greeks), [LME Black-76 reference](https://www.lme.com/en/trading/contract-types/options/black-scholes-76-formula).

With signed dealer inventory q and option/future multipliers m, finite hedge demand is `-sum(q * m_option/m_future * (delta(F+dF, IV+dIV, tau-dt)-delta(F,IV,tau)))`. The current Futu calculation substitutes an explicitly selected long/short fraction of OI; it is conditional potential, not observed dealer demand. Price-only, clock-only (charm-related), IV-only (vanna-related) endpoint revaluations and their interaction are reported separately. Charm is delta decay, not premium theta. The full joint revaluation is authoritative. Hedge changes across the first included positive-OI expiry are withheld because settlement/exercise and hedge disposal are not modeled. Expired options cease contributing to the option gamma curve; this does not describe disappearance of resulting futures positions.

A useful future research measure is absolute conditional hedge contracts divided by expected traded futures volume over the **same** 5/15/30-minute horizon, alongside direction, spread and depth. This is a proposed pressure ratio, not a validated impact probability; volume is not executable liquidity. Signed inventory, new intraday opening/closing flow and synchronized liquidity are missing. OI is not live signed inventory. No causal price-impact number or event-horizon probability is implemented.

### Empirical evidence and its limits

- [Dim, Eraker and Vilkov, revised June 2025](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4692190): SPX market-maker gamma is positive on average; inventory gamma sign conditions reversal versus momentum. This does not support universal destabilization.
- [Adams, Fontaine and Ornthanalai, revised June 2025](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4881008): the 2019–2023 study estimates 60–90 annualized basis points lower volatility on 0DTE days, discussing dealer matching and previously established positions.
- [Amaya et al., January 2025](https://cdn.cboe.com/resources/education/research_publications/gammasqueezes.pdf): proprietary minute-level SPX/SPXW positions, July 2020–June 2023. Typical estimated inventory effects reduce volatility. The appendix treats higher-order price curvature and charm; these can offset under its assumptions.
- [Brogaard, Han and Won, revised January 2026](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4426358): one-standard-deviation greater 0DTE trading is associated in its identification framework with a 9.10% increase in volatility relative to the mean, including mechanisms beyond gamma hedging. Trading activity and net dealer inventory are different explanatory variables; the papers do not estimate an identical effect.
- [Cboe, May 2025](https://www.cboe.com/insights/posts/0-dt-es-decoded-positioning-trends-and-market-impact): balanced customer flows and small net hedging relative to daily liquidity in the examined conditions. Daily aggregation cannot rule out concentrated minute-level stress.

These are predominantly SPX studies. Their numerical estimates are not transferred to NQ, ES or CL futures options. Test any predictive claim independently by product and time horizon using contemporaneously available captures, news/liquidity/time-of-day controls and chronological out-of-sample validation.

### UI and validation contract

- Provider 0DTE badges and confirmed same-day badges are separate; a mixed strike says Includes 0DTE. Counts refer to selected Futu input coverage, not the entire market.
- All / 0DTE / later controls filter Futu sensitivity only. The model clock advances explicitly by 0, 5, 15, 30 or 60 minutes from the saved snapshot; it does not claim a new live observation.
- Short-dashed paths include same-day contracts. Exact remaining time, IV, strike and OI determine curve shape. Dense local samples retain narrow sub-minute peaks in wide chart windows.
- Remaining-peak percentages normalize each current scenario's own peak, so they hide absolute height differences. Strike detail also shows unsigned equivalent futures sensitivity per price point.
- Tests cover NY date/DST boundaries, same-day versus next-day within 24h, mixed-expiry filtering, missing clocks, ATM growth/narrowing, far-OTM collapse, finite-delta decomposition and sign, expiry boundaries, and narrow-peak sampling.

The older visual-contract section below records the initial version. Current assets and size floors are documented in `planet-assets.md`; question marks were subsequently removed at the user's request, and numerical exposure was subsequently captured.

## What the evidence supports

1. **Barbon and Buraschi, Gamma Fragility (2021 working paper).** A large equity-option panel provides evidence of intraday momentum under negative gamma imbalance and reversal under positive imbalance, interacting with underlying illiquidity. Inventory is proxied, not directly observed. This supports conditional hedging feedback; it does not establish an event horizon at a vendor's wall. [Author paper](https://www.abarbon.com/assets/Barbon_Buraschi_2021_Gamma_Fragility.pdf), [SSRN abstract and version](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3725454).
2. **Ni, Pearson and Poteshman (2005), Journal of Financial Economics 78, 49–87.** Stock closing prices cluster at option strikes on expiration dates. Their estimate of average return displacement is at least 16.5 basis points on those dates; hedging and proprietary-trader manipulation both contribute. That is a sample estimate about expiration effects, not a wall-break success rate. [University publication record](https://experts.illinois.edu/en/publications/stock-price-clustering-on-option-expiration-dates/).
3. **Mandy Xu, Cboe, May 2, 2025.** The exchange's SPX 0DTE analysis reports balanced customer activity and estimated net gamma hedging at only 0.2% of daily SPX liquidity. This is an exchange study, not independent peer-reviewed evidence, and its denominator, period and market matter. It is a useful counterexample to equating gross options volume with large net hedging pressure. [Original report summary and full-report link](https://www.cboe.com/insights/posts/0-dt-es-decoded-positioning-trends-and-market-impact).

These findings cannot supply a numerical NQ, ES or CL breakout probability. Stock pinning, SPX options, and options on exact futures contracts have different settlement, exercise, inventory and liquidity characteristics.

## Mechanism and pushback

For a delta-neutral dealer book at fixed IV/time, with gamma expressed in consistent hedge units, dH ≈ −Gamma_dealer × dF. Positive gamma implies counter-move hedging; negative gamma implies same-direction hedging. A locally linear price-impact illustration dF = dF_external + lambda × dH implies dF = dF_external / (1 + lambda × Gamma_dealer). This is a simplified feedback illustration, not an estimated forecasting equation. Liquidity lambda, actual inventory, hedge timing and other flows are unknown; the linear approximation is not reliable near a singular denominator.

Gamma generally changes smoothly with price before expiration. A price wall is not necessarily a zero of aggregate signed gamma. A move away from a wall reinforced by short-gamma hedging differs from attraction back toward it. Crossing a strike does not create a no-return boundary. Calls and puts held long both have positive option gamma; inventory direction determines the dealer sign. Labeling a put wall as negative dealer gamma is unjustified.

Equal percentage decay does not mean equal absolute change: if compatible exposures are 100 and 10 units, a 50% decline leaves 50 and 5. The same ratio does not imply the same hedging demand, much less a fixed ratio of price impact.

## Visual contract

- Planet/body **area** uses absolute numerical MenthorQ strike GEX from the matching exact future and a declared unit. Diameter follows the square root of exposure relative to the largest reported strike magnitude in that market map. Compare within a map, not across markets.
- A 12px minimum diameter makes very small nonzero bodies visible; exact numbers remain authoritative. A reported zero uses a point. Missing, duplicate or uncalibrated values use a muted question-mark placeholder, never a zero or rank-derived mass.
- Main Put Support/Put Wall and Call Resistance/Call Wall labels receive M87-inspired rings. Separate 0DTE labels are not silently promoted. When multiple main labels cannot be ranked, identity is ambiguous. This does not prove the largest side-specific inventory across the market.
- Halo activity follows the existing own-peak, OI-based sensitivity curve at the price probe. Body area remains fixed to the provider map. Different timestamps and inventory bases make multiplying provider GEX by the modeled ratio unjustified; no such estimate is displayed.
- Provider date, delay status and source-clock uncertainty are visible. Out-of-curve main walls stay as reference cards. Selection, price slider/reset and original fade thresholds continue working.
- The asymmetric orange ring and shadow refer to [EHT Collaboration's M87 image via ESO](https://www.eso.org/public/images/eso1907a/). These are original CSS illustrations. The observed bright ring/shadow is not the physical event horizon.

## A falsifiable event-horizon study

Freeze each exact-contract wall and exposure map as known before a crossing; do not use end-of-day walls to explain earlier prices. Define a crossing with a tick/spread-aware buffer and first-crossing rule. Predefine 5-, 15- and 30-minute outcomes separately: continuation distance, return to the wall, maximum excursion, and realized volatility. Normalize distances by pre-event volatility and distinguish acceleration from simply a positive return.

Compare wall crossings with matched non-wall price levels, controlling for time of day, news, volatility, trend, spread/depth, expiry and contract roll. Stratify by estimated signed gamma and exposure-to-liquidity ratio. Use chronological out-of-sample evaluation, clustered confidence intervals for repeated events, and transaction costs. Test NQ, ES and CL separately. Include failed and missing captures in the coverage audit. Only then estimate whether crossing adds predictive value. Current saved maps lack numerical strike GEX and direct dealer inventory/order-book observations, so this study has not been run.
