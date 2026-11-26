const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const goalApiKey = process.env.GOAL_API_KEY;
const goalApiBase = "https://api.goal-api.com/v1/";
const fixturePageSize = 100;
const maxFixturePages = 100;

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function goalApiRequest(pathname) {
  const response = await fetch(new URL(pathname, goalApiBase), {
    headers: {
      Authorization: `Bearer ${goalApiKey}`,
      accept: "application/json"
    }
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GOAL API returned an invalid JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const detail = body?.message || body?.error;
    const extra = body?.details || body?.issues || body?.errors;
    const detailText = detail ? `: ${detail}` : "";
    const extraText = extra ? ` Details: ${JSON.stringify(extra).slice(0, 500)}` : "";
    throw new Error(`GOAL API returned HTTP ${response.status}${detailText}${extraText}.`);
  }
  if (body?.success !== true || !Array.isArray(body.data)) {
    throw new Error("GOAL API returned an unexpected fixtures response.");
  }
  return body;
}

function getFixtureStatus(event) {
  const status = String(event.matchStatus || event.status || "").toUpperCase();
  if (status === "LIVE" || event.matchLive === "1") return "live";
  if (["FINISHED", "FULL_TIME", "FT", "AFTER_ET", "AFTER_PEN", "AET", "PEN", "AWARDED"].includes(status)) {
    return "finished";
  }
  return "upcoming";
}

function normalizeFixture(event) {
  const homeName = event.homeTeamName || event.homeTeam?.name || "";
  const awayName = event.awayTeamName || event.awayTeam?.name || "";
  if (!event.id || !homeName || !awayName) return null;

  const status = getFixtureStatus(event);
  const homeScore = event.homeTeamScore ?? null;
  const awayScore = event.awayTeamScore ?? null;
  const hasFinalScore = status === "finished" &&
    homeScore !== null && homeScore !== "" &&
    awayScore !== null && awayScore !== "" &&
    Number.isFinite(Number(homeScore)) && Number.isFinite(Number(awayScore));
  const kickoff = event.kickoffUtc || event.date || event.matchDate || "";
  const league = event.leagueName || event.league?.name || "Football";
  const elapsed = event.matchElapsed ?? event.elapsed;

  const fixture = {
    id: `football-${event.id}`,
    sport: "football",
    source: "goal-api",
    date: kickoff,
    league,
    country: event.countryName || event.league?.country?.name || "",
    badge: league.slice(0, 3).toUpperCase(),
    time: status === "live" && elapsed !== undefined && elapsed !== null
      ? `${elapsed}'`
      : event.matchTime || event.time || "",
    status,
    home: {
      name: homeName,
      short: homeName.slice(0, 3).toUpperCase(),
      logo: event.teamHomeBadge || event.homeTeam?.badge || "",
      score: homeScore
    },
    away: {
      name: awayName,
      short: awayName.slice(0, 3).toUpperCase(),
      logo: event.teamAwayBadge || event.awayTeam?.badge || "",
      score: awayScore
    },
    marketLabel: "1X2 · MATCH RESULT",
    markets: [],
    recommendation: null,
    analysis: {
      form: "Recent form is not included in this fixture response.",
      h2h: "Head-to-head data is not included in this fixture response.",
      metrics: "No bookmaker odds or independent probability model is connected.",
      availability: "Lineup and injury data are not included in this fixture response."
    }
  };

  if (hasFinalScore) {
    const home = Number(homeScore);
    const away = Number(awayScore);
    fixture.result = {
      verified: true,
      provider: "GOAL API",
      marketKeys: [home > away ? "home" : home < away ? "away" : "draw"],
      label: `Final ${home}–${away}`
    };
  }
  return fixture;
}

function expandDateRange(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
      start.toISOString().slice(0, 10) !== from || end.toISOString().slice(0, 10) !== to || end < start) {
    const error = new Error("from and to must be valid dates in YYYY-MM-DD format, with to on or after from.");
    error.statusCode = 400;
    throw error;
  }
  const days = Math.round((end - start) / 86400000) + 1;
  if (days > 14) {
    const error = new Error("Date ranges are limited to 14 days to protect GOAL API request quotas.");
    error.statusCode = 400;
    throw error;
  }
}

async function getFixtures(from, to) {
  expandDateRange(from, to);
  if (!goalApiKey) {
    const error = new Error("Set GOAL_API_KEY in the server environment to load live data.");
    error.statusCode = 503;
    throw error;
  }

  const events = [];
  let offset = 0;
  for (let page = 0; page < maxFixturePages; page += 1) {
    const query = new URLSearchParams({
      from,
      to,
      limit: String(fixturePageSize),
      offset: String(offset)
    });
    const result = await goalApiRequest(`fixtures?${query}`);
    const total = Number(result.pagination?.total);
    if (Number.isInteger(total) && total > fixturePageSize * maxFixturePages) {
      throw new Error(`GOAL API reports ${total} fixtures in this date range, above OddSense's ${fixturePageSize * maxFixturePages}-fixture limit. Try a shorter date range.`);
    }
    events.push(...result.data);
    if (result.pagination?.hasMore !== true) break;
    const nextOffset = Number(result.pagination.offset) + Number(result.pagination.limit);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new Error("GOAL API returned invalid fixture pagination data.");
    }
    offset = nextOffset;
    if (page === maxFixturePages - 1) {
      throw new Error(`GOAL API returned more fixtures than OddSense can load in one request (${maxFixturePages * fixturePageSize}). Try a shorter date range.`);
    }
  }

  return { fixtures: events.map(normalizeFixture).filter(Boolean) };
}

function serveFile(requestPath, response) {
  const pathname = decodeURIComponent(requestPath);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!["index.html", "dashboard.html", "styles.css", "landing.css", "script.js", "landing.js"].includes(relative)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = path.resolve(root, relative);
  const relativePath = path.relative(root, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Could not read requested file");
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "x-content-type-options": "nosniff"
    });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/sports") {
    sendJson(response, 200, { provider: "GOAL API", sports: ["football"] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/fixtures") {
    const from = url.searchParams.get("from") || url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const to = url.searchParams.get("to") || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      sendJson(response, 400, { error: "from and to must use YYYY-MM-DD format." });
      return;
    }
    try {
      const result = await getFixtures(from, to);
      sendJson(response, 200, { provider: "GOAL API", ...result });
    } catch (error) {
      console.error(`GOAL API fixture request failed: ${error.message}`);
      sendJson(response, error.statusCode || 502, { error: error.message });
    }
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" });
    response.end("Method not allowed");
    return;
  }
  serveFile(url.pathname, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OddSense listening at http://localhost:${port}`);
});
