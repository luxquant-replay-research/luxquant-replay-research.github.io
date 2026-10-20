# Real Replay Market

Static publication of an independent 1-minute candle replay of LuxQuant signals.

Live: https://luxquant-replay-research.github.io/

This repository contains only the built `site/` output (HTML, JS, CSS and JSON data).
No credentials, Telegram sessions or API keys are included.

## Stop-management models

The published replay applies four stop rules: hold to final, move to entry after
TP1, move to TP1 after TP1, and move SL to TP1 after TP2 (the stop moves to TP1
only after TP2 is reached).

> **Correction (2026-10-20):** the fourth model previously used an incorrect
> stop placement. The data and UI have been corrected and regenerated.

> **Chart update (2026-10-20):** every chart now uses **1-minute** candles
> instead of the previous 5m/15m/1h snapshots. Candle files are loaded only
> when a chart modal opens, so the ledger JSON stays small.

Research only — not trading advice.
