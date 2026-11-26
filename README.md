# OddSense

OddSense is a responsive sports-odds analysis website. Its dashboard loads live football fixtures from GOAL API and does not fall back to demo data or claim that predictions are certain.

## Run locally

Use Node.js 18 or later. In PowerShell, from this folder:

```powershell
$env:GOAL_API_KEY = "your-key-from-GOAL-API"
node .\server.js
```

Open `http://localhost:4173` and keep the server terminal open. Provider keys stay in the server environment; do not put them in browser code or committed files. If you already have a server running, stop it with Ctrl+C before restarting it with the key set.

GOAL API is a football (soccer) provider. The dashboard supports date ranges of 1, 3, 7, or 14 days; requests are capped at 14 days and paginated. Basketball, tennis, and other sports need a separate data provider.

The current connector loads fixtures, team crests, scores, status, and final results. It does not request bookmaker odds. GOAL API documentation indicates that odds and predictions require a paid plan; without verified odds, OddSense will not create picks or allow them to be added to the betslip. Odds-derived percentages are market-implied, not an independent model or a guarantee.

Form, head-to-head, injuries, lineups, and other statistics are shown only when a configured provider supplies them. A selected market is marked as a known loss only after GOAL API returns a final fixture result.

SportyBet, Bet9ja, and MSport do not share a universal booking-code format. OddSense copies/shares a manual-entry slip; it does not invent a code or submit a bet. Users must enter selections in the official app and check its current prices.

Betting involves financial risk. Set limits and only wager money you can afford to lose.
