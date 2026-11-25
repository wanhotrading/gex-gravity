# CL expiry mapping

Reviewed 2026-11-06. Provider expiry dates and exact dated futures ownership are retained.

The standard American CL monthly LO and weekly ML/WL/LO1-5 clocks use the broker-published 13:30 America/Chicago expiration, equivalent to 14:30 America/New_York. Conversion uses IANA daylight-saving rules, not a constant UTC offset. Tastytrade's [official contract specifications](https://support.tastytrade.com/support/s/solutions/articles/43000503202) explicitly list monthly and Monday/Wednesday/Friday CL settlement and expiration at that clock. The official article was available through indexed text; direct opening returned a CSS error.

Tuesday/Thursday NL/XL use a documented inference: [CME's FAQ](https://www.cmegroup.com/articles/faqs/faq-tuesday-and-thursday-weekly-wti-options.html) says these share the existing weekly specifications. This distinction is retained in clock provenance. CME family rules establish exercise style and weekly date validation; the clock is broker-published, not a timestamp supplied by Futu or directly specified in the retrieved CME rulebook.

European monthly LCE remains unresolved. Neither Micro WTI rules nor a historical pit-close notice establish its current clock here. Existing conservative special-session review windows and unreviewed calendar years also remain unresolved; these exclusions do not assert that every affected day is closed. No holiday date shifting is inferred.

Saved rows are upgraded on read without refetching quotes or rewriting provider observations. Summary counts use the upgraded rows. American pricing is used for eligible contracts. Curves show only eligible series and retain excluded-series counts; missing clocks, IV or OI are never treated as zero exposure. Published expiry mapping does not establish Greek freshness or dealer ownership.

Validation covers every supported weekly family, monthly LO, decimal strikes, DST, holiday exclusions, LCE exclusion, saved-snapshot migration, mixed-expiry curves, and the 14:30 New York expiry cutoff.
