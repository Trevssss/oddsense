// API adapter contract for /api/fixtures:
// { fixtures: [{ id, sport, league, country, status, time, home, away,
//   markets: [{ key, label, odds }], recommendation: { marketKey, label, confidence },
//   result?: { verified, marketKeys, label, provider }, analysis }] }
// TODO: Connect additional live API endpoints here by normalizing provider data to this fixture schema.
// TODO: Connect an AI backend here with normalized fixture/market input and sourced analysis fields; never treat AI output as a verified result.
// Keep GOAL API credentials server-side; never put provider keys in this file.
let activeFixtures = [];
let availableSports = ["football"];
const state = {
  sport: "all",
  status: "all",
  selectedMarkets: new Map(),
  slip: [],
  bookmaker: "SportyBet",
  sortAscending: true,
  activeFixture: null,
  userSelectedFixtures: new Set(),
  dateFrom: "",
  daysAhead: 1,
  fixtureMessage: "Connecting to the configured sports feed…",
  sportsError: ""
};

const fixturesList = document.querySelector("#fixturesList");
const slipSelections = document.querySelector("#slipSelections");
const slipEmpty = document.querySelector("#slipEmpty");
const toast = document.querySelector("#toast");
const analystModal = document.querySelector("#analystModal");
let toastTimer;
let fixtureRequestSequence = 0;

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const getFixture = id => activeFixtures.find(fixture => fixture.id === id);
const marketsFor = fixture => Array.isArray(fixture.markets) ? fixture.markets : [];
const defaultMarket = fixture => marketsFor(fixture)[0];
const fixtureDisplayName = fixture => `${fixture.home.name} vs ${fixture.away.name}`;
const recommendationLabel = fixture => fixture.recommendation?.type === "market-consensus"
  ? "market favorite"
  : "model lean";
const getRecommendation = fixture => {
  const markets = marketsFor(fixture);
  const key = fixture.recommendation?.marketKey || fixture.recommendedMarketKey;
  return key ? markets.find(market => market.key === key) || null : null;
};
const isVerifiedResult = fixture => fixture.source === "goal-api" && fixture.status === "finished" && fixture.result?.verified === true;
const isResultMarket = market => ["home", "draw", "away"].includes(market.key);

function getSportLabel(sport) {
  const labels = {
    football: "Football (Soccer)",
    basketball: "Basketball",
    tennis: "Tennis",
    american_football: "American Football",
    baseball: "Baseball",
    cricket: "Cricket",
    hockey: "Hockey",
    rugby: "Rugby",
    volleyball: "Volleyball"
  };
  return labels[sport] || sport.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function renderSportTabs() {
  const nav = document.querySelector("#sportsNav");
  const sports = [...new Set([...availableSports, ...activeFixtures.map(fixture => fixture.sport).filter(Boolean)])].sort();
  const options = [{ id: "all", label: "All Sports", icon: "◈" }, ...sports.map(sport => ({
    id: sport,
    label: getSportLabel(sport),
    icon: ({ football: "⚽", basketball: "🏀", tennis: "🎾" })[sport] || "◉"
  }))];
  if (!options.some(option => option.id === state.sport)) state.sport = "all";
  nav.innerHTML = options.map(option => `<button class="sport-tab ${state.sport === option.id ? "active" : ""}" type="button" data-sport="${escapeHtml(option.id)}" aria-pressed="${state.sport === option.id}"><span class="tab-icon">${option.icon}</span> ${escapeHtml(option.label)}</button>`).join("") +
    (state.sportsError ? `<span class="sports-error" role="status">${escapeHtml(state.sportsError)}</span>` : "");
}

async function loadAvailableSports() {
  if (window.location.protocol === "file:") return;
  const response = await fetch("/api/sports", { headers: { Accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Could not load configured sports (${response.status}).`);
  if (!payload || !Array.isArray(payload.sports) || payload.sports.some(sport => typeof sport !== "string" || !sport.trim())) {
    throw new Error("The sports configuration response must contain a sports array.");
  }
  availableSports = [...new Set(payload.sports.map(sport => sport.trim()))];
  state.sportsError = "";
  renderSportTabs();
}

function renderProviderStatus(message) {
  document.querySelector("#providerStatus").textContent = message;
  const connected = message.startsWith("GOAL API");
  const loading = message.startsWith("Loading");
  document.querySelector(".online-label").innerHTML = `<i></i> ${connected ? "Connected" : loading ? "Loading" : "Unavailable"}`;
  document.querySelector(".overview-card.ai-overview small").textContent = message.startsWith("GOAL API")
    ? "Fixtures only · bookmaker odds unavailable"
    : loading ? "Fetching selected date range" : "Set GOAL_API_KEY to load fixtures";
  updateLivePill(connected, loading);
}

function updateLivePill(connected, loading) {
  const liveCount = activeFixtures.filter(fixture => fixture.status === "live").length;
  const pill = document.querySelector("#livePill");
  pill.classList.toggle("has-live", liveCount > 0);
  pill.innerHTML = liveCount
    ? `<i></i> ${liveCount} LIVE`
    : loading ? "<i></i> CHECKING" : connected ? "<i></i> NO LIVE FIXTURES" : "<i></i> LIVE DATA OFF";
}

function formatFixtureDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function teamMarkup(team, score) {
  const shortName = team.short || team.name.split(/\s+/).map(part => part[0]).join("").slice(0, 3).toUpperCase();
  const logo = typeof team.logo === "string" && /^https?:\/\//i.test(team.logo) ? team.logo : "";
  const watermark = logo
    ? `<img class="team-watermark" src="${escapeHtml(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="team-watermark-text">${escapeHtml(shortName)}</span>`;
  return `<div class="team-row"><span class="team-crest ${escapeHtml(team.crest || "")}">${escapeHtml(shortName)}</span><span class="team-name"><span class="team-name-text">${escapeHtml(team.name)}</span>${watermark}</span>${score !== undefined && score !== null ? `<span class="team-score">${escapeHtml(score)}</span>` : ""}</div>`;
}

function normalizeProviderFixtures(payload) {
  if (!payload || !Array.isArray(payload.fixtures)) {
    throw new Error("The API adapter did not return a fixtures array.");
  }
  return payload.fixtures.map(fixture => {
    if (!fixture.id || !fixture.sport || !fixture.home?.name || !fixture.away?.name) {
      throw new Error("The API adapter returned a fixture with missing ID, sport, or team data.");
    }
    if (!["live", "upcoming", "finished"].includes(fixture.status)) {
      throw new Error(`Unsupported fixture status for ${fixture.id}.`);
    }
    const markets = Array.isArray(fixture.markets) ? fixture.markets.filter(market =>
      market.key && market.label && Number.isFinite(Number(market.odds)) && Number(market.odds) > 1
    ).map(market => ({ ...market, odds: Number(market.odds) })) : [];
    return {
      ...fixture,
      source: "goal-api",
      markets,
      home: { ...fixture.home, score: fixture.home.score ?? null },
      away: { ...fixture.away, score: fixture.away.score ?? null },
      result: fixture.result?.verified === true && fixture.result?.provider === "GOAL API"
        ? fixture.result
        : null
    };
  });
}

function addIsoDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function updateDateLabel() {
  const endDate = addIsoDays(state.dateFrom, state.daysAhead - 1);
  const format = value => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  document.querySelector("#selectedDateLabel").textContent = state.daysAhead === 1
    ? format(state.dateFrom)
    : `${format(state.dateFrom)} – ${format(endDate)}`;
}

async function loadProviderFixtures(dateFrom, daysAhead = state.daysAhead) {
  const requestSequence = ++fixtureRequestSequence;
  if (window.location.protocol === "file:") {
    if (requestSequence !== fixtureRequestSequence) return;
    activeFixtures = [];
    state.fixtureMessage = "This dashboard was opened as a local file and cannot load live fixtures. Start the server with `node .\\server.js`, then open http://localhost:4173/dashboard.html.";
    renderProviderStatus("LIVE DATA UNAVAILABLE · Start the local server to load fixtures.");
    renderFixtures();
    return;
  }
  const dateTo = addIsoDays(dateFrom, daysAhead - 1);
  if (activeFixtures.length === 0) state.fixtureMessage = "Checking the configured live data feed…";
  renderProviderStatus(`Loading GOAL API fixtures · ${dateFrom} to ${dateTo}`);
  if (activeFixtures.length === 0) renderFixtures();
  try {
    const response = await fetch(`/api/fixtures?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}`, { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `GOAL API request failed (${response.status}).`);
    if (requestSequence !== fixtureRequestSequence) return;
    if (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.some(item => !item?.sport || !item?.message))) {
      throw new Error("The API adapter returned an invalid product-error list.");
    }
    const productErrors = payload.errors || [];
    const errorSummary = productErrors.map(item => `${getSportLabel(item.sport)}: ${item.message}`).join("; ");
    activeFixtures = normalizeProviderFixtures(payload);
    state.fixtureMessage = activeFixtures.length
      ? ""
      : errorSummary
        ? `GOAL API could not load fixtures: ${errorSummary}. Check your key, plan access, and request allowance.`
        : "GOAL API connected, but returned no fixtures in this date range. Try another date range.";
    const fixturesById = new Map(activeFixtures.map(fixture => [fixture.id, fixture]));
    let removedSelections = 0;
    state.slip = state.slip.flatMap(pick => {
      const fixture = fixturesById.get(pick.fixtureId);
      const market = fixture && marketsFor(fixture).find(item => item.key === pick.marketKey);
      if (!market) {
        removedSelections += 1;
        return [];
      }
      return [{ ...pick, odds: market.odds }];
    });
    state.userSelectedFixtures.clear();
    state.selectedMarkets.clear();
    state.slip.forEach(pick => {
      const fixture = fixturesById.get(pick.fixtureId);
      const market = fixture && marketsFor(fixture).find(item => item.key === pick.marketKey);
      if (market) {
        state.userSelectedFixtures.add(pick.fixtureId);
        state.selectedMarkets.set(pick.fixtureId, market);
      }
    });
    renderProviderStatus(errorSummary && activeFixtures.length === 0
      ? `LIVE DATA UNAVAILABLE · ${errorSummary}`
      : `GOAL API · ${activeFixtures.length} fixtures · ${dateFrom} to ${dateTo}${errorSummary ? ` · ${errorSummary}` : ""} · predictions are not guaranteed`);
    renderFixtures();
    renderSlip();
    document.querySelector("#bookingResult").hidden = true;
    if (removedSelections) showToast(`${removedSelections} stale slip selection${removedSelections === 1 ? "" : "s"} removed.`);
  } catch (error) {
    if (requestSequence !== fixtureRequestSequence) return;
    const removedSelections = state.slip.length;
    activeFixtures = [];
    state.slip = [];
    state.selectedMarkets.clear();
    state.userSelectedFixtures.clear();
    const message = error.message.includes("Set GOAL_API_KEY")
      ? "Live fixtures are not configured. Set GOAL_API_KEY in the server environment, restart `node .\\server.js`, then refresh. No sample fixtures are shown."
      : error instanceof TypeError
        ? "Cannot connect to the OddSense local server. Start it with `node .\\server.js` and open http://localhost:4173/dashboard.html."
        : `The GOAL API request failed: ${error.message} Check the API key, plan access and request limits.`;
    state.fixtureMessage = message;
    renderProviderStatus(`LIVE DATA UNAVAILABLE · ${error.message}`);
    renderFixtures();
    renderSlip();
    document.querySelector("#bookingResult").hidden = true;
    if (removedSelections) showToast("Slip cleared because live fixture data could not be verified.");
  }
}

function renderFixtures() {
  renderSportTabs();
  let visible = activeFixtures.filter(fixture =>
    (state.sport === "all" || fixture.sport === state.sport) &&
    (state.status === "all" || fixture.status === state.status)
  );
  visible = [...visible].sort((a, b) => {
    const dateA = new Date(a.date || a.startTime || 0).getTime();
    const dateB = new Date(b.date || b.startTime || 0).getTime();
    return dateA - dateB;
  });
  if (!state.sortAscending) visible.reverse();
  fixturesList.innerHTML = visible.length === 0
    ? `<div class="no-fixtures">${escapeHtml(state.fixtureMessage || "No fixtures match the selected sport and date range.")}</div>`
    : visible.map(fixture => {
    const markets = marketsFor(fixture);
    const selected = state.selectedMarkets.get(fixture.id) || defaultMarket(fixture);
    const recommendation = getRecommendation(fixture);
    const hasUserPick = state.userSelectedFixtures.has(fixture.id);
    const verified = isVerifiedResult(fixture);
    const resultKeys = Array.isArray(fixture.result?.marketKeys) ? fixture.result.marketKeys : [];
    const selectionLost = Boolean(hasUserPick && verified && selected && isResultMarket(selected) && !resultKeys.includes(selected.key));
    const selectionWon = Boolean(hasUserPick && verified && selected && isResultMarket(selected) && resultKeys.includes(selected.key));
    const modelDisagrees = Boolean(!verified && hasUserPick && recommendation && selected?.key !== recommendation.key);
    const isLive = fixture.status === "live";
    const fixtureDate = formatFixtureDate(fixture.date);
    const timeLabel = fixture.time || "Scheduled";
    const statusText = isLive ? `LIVE ${timeLabel}` : fixture.status === "finished" ? "FINAL" : `${fixtureDate ? `${fixtureDate} · ` : ""}${timeLabel}`;
    const confidence = fixture.recommendation?.confidence ?? fixture.confidence;
    const hasConfidence = confidence !== null && confidence !== undefined && Number.isFinite(Number(confidence));
    const probabilityLabel = fixture.recommendation?.type === "market-consensus"
      ? "IMPLIED PROBABILITY"
      : fixture.confidence !== null && fixture.confidence !== undefined ? "MODEL ESTIMATE" : "ODDS ESTIMATE";
    return `<article class="match-card ${isLive ? "live-card" : ""}" data-fixture-id="${escapeHtml(fixture.id)}">
      <div class="match-topline">
        <div class="league-info"><span class="league-badge">${escapeHtml(fixture.badge || fixture.sport.slice(0, 3).toUpperCase())}</span><span>${escapeHtml(fixture.league || getSportLabel(fixture.sport))}</span><span class="league-country">· ${escapeHtml(fixture.country || "")}</span></div>
        <span class="match-state ${isLive ? "live" : verified ? "finished" : ""}">${escapeHtml(statusText)}</span>
      </div>
      <div class="match-main">
        <div class="teams">
          ${teamMarkup(fixture.home, fixture.home.score)}
          <div class="vs-label">VS</div>
          ${teamMarkup(fixture.away, fixture.away.score)}
        </div>
        <div class="probability"><div class="probability-title"><span>${probabilityLabel}</span><strong>${hasConfidence ? `${escapeHtml(confidence)}%` : "—"}</strong></div><div class="probability-track"><span style="width:${hasConfidence ? Math.max(0, Math.min(100, Number(confidence))) : 0}%"></span></div><span class="probability-caption">${escapeHtml(recommendation ? `${recommendationLabel(fixture)}: ${recommendation.label}` : "No odds-based estimate")}</span></div>
      </div>
      <div class="odds-block">
        <div class="odds-label"><span>${escapeHtml(fixture.marketLabel || `${getSportLabel(fixture.sport).toUpperCase()} MARKETS`)}</span><span>DECIMAL ODDS</span></div>
        ${markets.length ? `<div class="odds-row">${markets.map(market => {
          const isRecommended = recommendation?.key === market.key;
          const isSelected = selected?.key === market.key;
          const isLost = hasUserPick && verified && isSelected && isResultMarket(market) && !resultKeys.includes(market.key);
          const isWon = verified && isResultMarket(market) && resultKeys.includes(market.key);
          const disagrees = !verified && hasUserPick && isSelected && !isRecommended;
          const marketClasses = ["odd-button", isSelected ? "selected" : "", isRecommended ? "model-favorite" : "", isLost ? "settled-loss" : "", isWon ? "settled-win" : "", disagrees ? "model-disagree flash-red" : ""].filter(Boolean).join(" ");
          const marker = isRecommended ? fixture.recommendation?.type === "market-consensus" ? " · MARKET FAVORITE" : " · MODEL LEAN" : "";
          return `<button type="button" class="${marketClasses}" data-market="${escapeHtml(market.key)}" aria-pressed="${isSelected}" aria-label="Select ${escapeHtml(market.label)} at odds ${market.odds}${marker}" title="${isRecommended ? recommendationLabel(fixture) : "Select this market"}"><span>${escapeHtml(market.label)}${isRecommended ? " ★" : ""}</span><strong>${Number(market.odds).toFixed(2)}</strong></button>`;
        }).join("")}</div>` : `<p class="odds-unavailable">Verified odds are not available for this fixture.</p>`}
      </div>
      ${modelDisagrees ? `<div class="pick-feedback mismatch" role="status">This pick differs from the ${escapeHtml(recommendationLabel(fixture))}. It leans ${escapeHtml(recommendation.label)} — this is guidance, not a known result. <button type="button" data-action="use-model">Select ${escapeHtml(recommendationLabel(fixture))}</button></div>` : ""}
      ${selectionLost ? `<div class="pick-feedback mismatch" role="status">Verified final: ${escapeHtml(fixture.result.label || recommendation?.label || "result received")}. This selected outcome lost.</div>` : ""}
      ${selectionWon ? `<div class="pick-feedback confirmed" role="status">Verified final: ${escapeHtml(fixture.result.label || selected.label)}. This selected outcome won.</div>` : ""}
      <div class="card-bottom"><span class="market-note">✦ Odds insight: <strong>${escapeHtml(fixture.note || (recommendation ? `${recommendationLabel(fixture)}: ${recommendation.label}` : "No odds-based insight available"))}</strong></span><div class="card-actions"><button type="button" class="ask-button" data-action="analyse">✦ Ask OddSense AI</button><button type="button" class="add-button" data-action="add" ${markets.length ? "" : "disabled"}><span>＋</span> Add to Slip</button></div></div>
    </article>`;
    }).join("");
  const liveCount = activeFixtures.filter(fixture => fixture.status === "live").length;
  const upcomingCount = activeFixtures.filter(fixture => fixture.status === "upcoming").length;
  const feedAvailable = document.querySelector("#providerStatus").textContent.startsWith("GOAL API");
  updateLivePill(feedAvailable, false);
  document.querySelector("#matchCount").textContent = String(activeFixtures.length).padStart(2, "0");
  document.querySelector(".overview-card:nth-child(2) strong").textContent = String(liveCount).padStart(2, "0");
  document.querySelector(".overview-card:nth-child(2) small").textContent = liveCount ? `${liveCount} in-play fixture${liveCount === 1 ? "" : "s"}` : feedAvailable ? "No active fixtures in range" : "Live feed unavailable";
  document.querySelector(".overview-card:first-child small").textContent = `Across ${new Set(activeFixtures.map(fixture => fixture.league).filter(Boolean)).size} competitions`;
  const topMarket = activeFixtures.map(fixture => ({
    fixture,
    recommendation: getRecommendation(fixture),
    confidence: fixture.recommendation?.confidence ?? fixture.confidence
  })).filter(item => item.recommendation && Number.isFinite(Number(item.confidence)))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
  document.querySelector(".overview-card:nth-child(3) strong").textContent = topMarket ? `${topMarket.confidence}%` : "—";
  document.querySelector(".overview-card:nth-child(3) small").textContent = topMarket
    ? `${escapeHtml(topMarket.recommendation.label)} · market implied`
    : "No verified odds available";
  document.querySelectorAll(".status-tab").forEach(button => {
    const count = button.dataset.status === "all" ? activeFixtures.length : button.dataset.status === "live" ? liveCount : upcomingCount;
    const badge = button.querySelector("span");
    if (badge) badge.textContent = String(count).padStart(2, "0");
  });
  document.querySelector(".match-total").textContent = `${String(visible.length).padStart(2, "0")} MATCHES`;
}

function renderSlip() {
  const count = state.slip.length;
  document.querySelector("#slipCount").textContent = count;
  document.querySelector("#slipCountTop").textContent = count;
  slipEmpty.hidden = count > 0;
  slipSelections.innerHTML = state.slip.map(pick => {
    const fixture = getFixture(pick.fixtureId);
    if (!fixture) return "";
    const finished = isVerifiedResult(fixture) && isResultMarket({ key: pick.marketKey });
    const won = finished && fixture.result.marketKeys.includes(pick.marketKey);
    const resultClass = finished ? won ? "settled-win" : "settled-loss" : "";
    const resultNote = finished ? `<div class="selection-result ${won ? "confirmed" : "mismatch"}">Verified final: ${escapeHtml(fixture.result.label || "result received")} · ${won ? "Won" : "Lost"}</div>` : "";
    return `<article class="slip-selection ${resultClass}">
      <div class="selection-head"><span>${escapeHtml(fixture.league.toUpperCase())}</span><strong>${pick.odds.toFixed(2)}</strong></div>
      <div class="selection-match">${escapeHtml(fixtureDisplayName(fixture))}</div>
      <div class="selection-pick">${escapeHtml(pick.label)}</div>
      ${resultNote}
      <button class="remove-pick" type="button" data-remove="${escapeHtml(fixture.id)}" aria-label="Remove ${escapeHtml(fixtureDisplayName(fixture))} from betslip">×</button>
    </article>`;
  }).join("");
  const totalOdds = state.slip.reduce((total, pick) => total * pick.odds, 1);
  const stake = Number(document.querySelector("#stakeInput").value) || 0;
  document.querySelector("#totalOdds").textContent = totalOdds.toFixed(2);
  document.querySelector("#potentialPayout").textContent = `₦${(stake * totalOdds).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.querySelector("#prepareSlip").disabled = count === 0;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function addToSlip(fixture, market) {
  if (!market || !Number.isFinite(Number(market.odds)) || Number(market.odds) <= 1) {
    showToast("This selection has no verified odds and cannot be added.");
    return;
  }
  const pick = { fixtureId: fixture.id, marketKey: market.key, label: market.label, odds: Number(market.odds) };
  state.selectedMarkets.set(fixture.id, market);
  state.userSelectedFixtures.add(fixture.id);
  const existingIndex = state.slip.findIndex(item => item.fixtureId === fixture.id);
  if (existingIndex >= 0) state.slip.splice(existingIndex, 1, pick);
  else state.slip.push(pick);
  document.querySelector("#bookingResult").hidden = true;
  renderFixtures();
  renderSlip();
  showToast(`${market.label} added to your betslip`);
}

function buildAnalysis(fixture) {
  const analysis = fixture.analysis || {};
  const recommendation = getRecommendation(fixture);
  const verdict = recommendation?.label || analysis.verdict || "No odds-based lean available";
  const verdictOdds = recommendation?.odds || analysis.verdictOdds;
  const risk = analysis.risk || "UNRATED · NO INDEPENDENT MODEL";
  const primaryLabel = fixture.recommendation?.type === "market-consensus"
    ? "MARKET FAVORITE · IMPLIED PROBABILITY"
    : recommendation ? "MODEL LEAN · NOT A CERTAINTY" : "NO DATA-BASED LEAN";
  const dataBadge = fixture.recommendation?.type === "market-consensus"
    ? "BOOKMAKER FAVORITE · NOT A MODEL"
    : "API DATA · OUTCOME NOT GUARANTEED";
  const impliedNote = recommendation?.type === "market-consensus"
    ? `Displayed odds imply approximately ${recommendation.confidence}% for ${recommendation.label} after normalizing the listed outcomes. This is bookmaker consensus, not an independent prediction.`
    : "An odds-based estimate is unavailable for this fixture.";
  const statValue = value => escapeHtml(value || "Not included in the current GOAL API fixture feed.");
  return `<div class="verdict-box">
    <div class="verdict-label"><span>${escapeHtml(primaryLabel)}</span><strong>${escapeHtml(dataBadge)}</strong></div>
    <div class="verdict-pick">${escapeHtml(verdict)} <span>${verdictOdds ? escapeHtml(verdictOdds) : "—"}</span></div>
    <span class="risk-tag">◈ ${escapeHtml(risk)}</span>
  </div>
  <h3 class="analysis-heading">THE DATA BREAKDOWN</h3>
  <div class="analysis-grid">
    <div class="analysis-stat"><small>RECENT FORM</small><strong>${statValue(analysis.form)}</strong></div>
    <div class="analysis-stat"><small>HEAD-TO-HEAD</small><strong>${statValue(analysis.h2h)}</strong></div>
    <div class="analysis-stat"><small>ODDS & PROBABILITY</small><strong>${escapeHtml(analysis.metrics || impliedNote)}</strong></div>
    <div class="analysis-stat"><small>LINEUP & AVAILABILITY</small><strong>${statValue(analysis.availability)}</strong></div>
  </div>
  <button class="ai-pick-button" type="button" data-action="ai-add" data-market-key="${escapeHtml(recommendation?.key || "")}" ${recommendation ? "" : "disabled"}><span>＋</span> Add ${escapeHtml(recommendation?.label || "odds-based pick")} to Betslip <span>${recommendation?.odds ? `· ${Number(recommendation.odds).toFixed(2)}` : ""}</span></button>`;
}

function openAnalyst(fixture) {
  state.activeFixture = fixture;
  const dateText = formatFixtureDate(fixture.date);
  const statusText = fixture.status === "live" ? `LIVE ${fixture.time}` : `${dateText ? `${dateText} · ` : ""}${fixture.time || "Scheduled"}`;
  document.querySelector("#analystMatch").innerHTML = `<div class="analyst-fixture-top"><span>${escapeHtml(fixture.league)} · ${escapeHtml(fixture.country)}</span><span class="${fixture.status === "live" ? "analyst-live" : ""}">${escapeHtml(statusText)}</span></div>
    <div class="analyst-fixture-teams"><span>${escapeHtml(fixture.home.name)}${fixture.home.score != null ? ` ${escapeHtml(fixture.home.score)}` : ""}</span><em>VS</em><span>${fixture.away.score != null ? `${escapeHtml(fixture.away.score)} ` : ""}${escapeHtml(fixture.away.name)}</span></div>`;
  document.querySelector("#analystOutput").innerHTML = buildAnalysis(fixture);
  document.querySelector("#analystQuestion").value = "";
  analystModal.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#closeAnalyst").focus();
}

function closeAnalyst() {
  analystModal.hidden = true;
  document.body.style.overflow = "";
}

function answerQuestion(question) {
  const fixture = state.activeFixture;
  const analysis = fixture.analysis || {};
  const recommendation = getRecommendation(fixture);
  const normalized = question.toLowerCase();
  let answer;
  if ((normalized.includes("safe") || normalized.includes("safest")) && !normalized.includes("accumulator") && !normalized.includes("3-odds")) {
    answer = recommendation
      ? `The current ${recommendationLabel(fixture)} is ${recommendation.label} at ${Number(recommendation.odds).toFixed(2)}. This is not a safe or guaranteed outcome; verify the current price and consider passing if it no longer offers value.`
      : "There are no current odds to compare for this fixture, so OddSense cannot provide a pick. Do not treat missing data as a safe outcome.";
  } else if (normalized.includes("form") || normalized.includes("last 5")) {
    answer = analysis.form
      ? `Recent sample for this fixture: ${analysis.form}. Form is descriptive context only and does not guarantee future results.`
      : "Recent form is not included in the current GOAL API fixture response. I won't infer or invent it.";
  } else if (normalized.includes("injur") || normalized.includes("lineup") || normalized.includes("player")) {
    answer = analysis.availability || "Injury and lineup information is not included in the current feed. Check official team announcements before kickoff.";
  } else if (normalized.includes("accumulator") || normalized.includes("3-odds")) {
    answer = "No accumulator is safe or guaranteed. Build legs only from the current verified odds feed; this assistant will not invent picks or prices. Each added leg increases risk.";
  } else {
    answer = recommendation
      ? `For ${fixtureDisplayName(fixture)}, the current ${recommendationLabel(fixture)} is ${recommendation.label} at ${Number(recommendation.odds).toFixed(2)}. ${analysis.metrics || "This is bookmaker-implied probability, not an independent prediction."} No outcome is certain.`
      : `For ${fixtureDisplayName(fixture)}, live odds are not available yet. The feed will not create a pick without them.`;
  }
  const response = document.createElement("div");
  response.className = "analyst-response";
  response.textContent = answer;
  document.querySelector("#analystOutput").appendChild(response);
}

function formatBookingSummary() {
  const totalOdds = state.slip.reduce((total, pick) => total * pick.odds, 1);
  const stake = Number(document.querySelector("#stakeInput").value) || 0;
  const selections = state.slip.map(pick => {
    const fixture = getFixture(pick.fixtureId);
    return `• ${fixtureDisplayName(fixture)} — ${pick.label} @ ${pick.odds.toFixed(2)}`;
  }).join("\n");
  return `OddSense manual-entry slip · ${state.bookmaker}\n${selections}\nTotal odds: ${totalOdds.toFixed(2)}\nStake: ₦${stake.toLocaleString("en-NG")}\nPotential payout: ₦${(totalOdds * stake).toLocaleString("en-NG", { maximumFractionDigits: 2 })}\n\nThis is not a bookmaker booking code. Enter each selection in the official app and verify its current odds. Bet responsibly.`;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
}

document.querySelector(".sports-nav").addEventListener("click", event => {
  const button = event.target.closest("[data-sport]");
  if (!button) return;
  state.sport = button.dataset.sport;
  document.querySelectorAll(".sport-tab").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  renderFixtures();
});

document.querySelector(".feed-toggle").addEventListener("click", event => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  state.status = button.dataset.status;
  document.querySelectorAll(".status-tab").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  renderFixtures();
});

fixturesList.addEventListener("click", event => {
  const card = event.target.closest("[data-fixture-id]");
  if (!card) return;
  const fixture = getFixture(card.dataset.fixtureId);
  if (event.target.closest(".odd-button")) {
    const button = event.target.closest(".odd-button");
    const market = marketsFor(fixture).find(item => item.key === button.dataset.market);
    if (!market) return;
    state.selectedMarkets.set(fixture.id, market);
    state.userSelectedFixtures.add(fixture.id);
    const recommendation = getRecommendation(fixture);
    const disagrees = Boolean(recommendation && market.key !== recommendation.key && !isVerifiedResult(fixture));
    renderFixtures();
    if (disagrees) {
      const selectedButton = [...fixturesList.querySelectorAll(`[data-fixture-id="${CSS.escape(fixture.id)}"] .odd-button`)]
        .find(item => item.dataset.market === market.key);
      if (selectedButton) {
        selectedButton.classList.remove("flash-red");
        void selectedButton.offsetWidth;
        selectedButton.classList.add("flash-red");
      }
    }
  } else if (event.target.closest('[data-action="analyse"]')) {
    openAnalyst(fixture);
  } else if (event.target.closest('[data-action="add"]')) {
    addToSlip(fixture, state.selectedMarkets.get(fixture.id) || defaultMarket(fixture));
  } else if (event.target.closest('[data-action="use-model"]')) {
    const recommendation = getRecommendation(fixture);
    if (!recommendation) return;
    state.selectedMarkets.set(fixture.id, recommendation);
    state.userSelectedFixtures.add(fixture.id);
    renderFixtures();
  }
});

slipSelections.addEventListener("click", event => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  state.slip = state.slip.filter(pick => pick.fixtureId !== button.dataset.remove);
  renderSlip();
  document.querySelector("#bookingResult").hidden = true;
});

document.querySelector("#stakeInput").addEventListener("input", renderSlip);
document.querySelector("#clearSlip").addEventListener("click", () => {
  state.slip = [];
  renderSlip();
  document.querySelector("#bookingResult").hidden = true;
});

document.querySelector(".bookmaker-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-bookmaker]");
  if (!button) return;
  state.bookmaker = button.dataset.bookmaker;
  document.querySelectorAll(".bookmaker-tab").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#bookingResult").hidden = true;
});

document.querySelector("#prepareSlip").addEventListener("click", () => {
  if (state.slip.length === 0) return;
  const result = document.querySelector("#bookingResult");
  const summary = formatBookingSummary();
  result.innerHTML = `<h3>Manual-entry slip ready</h3><p>${escapeHtml(state.bookmaker)} · ${state.slip.length} selection${state.slip.length === 1 ? "" : "s"}</p><pre class="booking-summary">${escapeHtml(summary)}</pre><div class="booking-actions"><button type="button" data-booking-action="copy">▣ Copy full slip</button><button type="button" data-booking-action="share">↗ Share slip</button></div>`;
  result.hidden = false;
});

document.querySelector("#bookingResult").addEventListener("click", async event => {
  const button = event.target.closest("[data-booking-action]");
  if (!button) return;
  if (button.dataset.bookingAction === "copy") {
    try {
      await copyText(formatBookingSummary());
      showToast("Full slip copied — enter each pick in the app.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: "My OddSense Betslip", text: formatBookingSummary() });
    } catch (error) {
      if (error.name !== "AbortError") showToast("Unable to share this slip.");
    }
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(formatBookingSummary())}`, "_blank", "noopener,noreferrer");
  }
});

document.querySelector("#analystOutput").addEventListener("click", event => {
  if (!event.target.closest('[data-action="ai-add"]') || !state.activeFixture) return;
  const fixture = state.activeFixture;
  const market = marketsFor(fixture).find(item => item.key === event.target.closest("[data-market-key]").dataset.marketKey);
  if (!market) {
    showToast("This odds-based pick is not in the verified odds feed.");
    return;
  }
  state.selectedMarkets.set(fixture.id, market);
  state.userSelectedFixtures.add(fixture.id);
  addToSlip(fixture, market);
  closeAnalyst();
});

document.querySelector("#analystForm").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#analystQuestion");
  const question = input.value.trim();
  if (!question) return;
  answerQuestion(question);
  input.value = "";
});

document.querySelector("#closeAnalyst").addEventListener("click", closeAnalyst);
analystModal.addEventListener("click", event => {
  if (event.target === analystModal) closeAnalyst();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeAnalyst();
    closeMobileSlip();
  }
});

document.querySelector("#sortButton").addEventListener("click", () => {
  state.sortAscending = !state.sortAscending;
  renderFixtures();
});
document.querySelector("#loadMoreButton").addEventListener("click", () => loadProviderFixtures(state.dateFrom, state.daysAhead));

const betslip = document.querySelector("#betslip");
const mobileBackdrop = document.querySelector("#mobileBackdrop");
function closeMobileSlip() {
  betslip.classList.remove("mobile-open");
  mobileBackdrop.classList.remove("open");
}
document.querySelector("#mobileSlipTrigger").addEventListener("click", () => {
  betslip.classList.add("mobile-open");
  mobileBackdrop.classList.add("open");
});
document.querySelector("#closeSlip").addEventListener("click", closeMobileSlip);
mobileBackdrop.addEventListener("click", closeMobileSlip);

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

document.querySelector("#dateInput").addEventListener("change", event => {
  if (!event.target.value) return;
  state.dateFrom = event.target.value;
  updateDateLabel();
  loadProviderFixtures(state.dateFrom, state.daysAhead);
});

document.querySelector(".date-range-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-days]");
  if (!button) return;
  state.daysAhead = Number(button.dataset.days);
  document.querySelectorAll(".date-range-tabs button").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  updateDateLabel();
  loadProviderFixtures(state.dateFrom, state.daysAhead);
});

state.dateFrom = localDateValue();
document.querySelector("#dateInput").value = state.dateFrom;
updateDateLabel();
renderFixtures();
renderSlip();
loadAvailableSports().catch(error => {
  state.sportsError = `Configured sports unavailable: ${error.message}`;
  renderSportTabs();
});
loadProviderFixtures(state.dateFrom, state.daysAhead);
