import https from "node:https";

// =========================
// ENV
// =========================

const TELEGRAM_TOKEN = process.env["TELEGRAM_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
const API_KEY = process.env["API_FOOTBALL_KEY"];

if (!TELEGRAM_TOKEN || !CHAT_ID || !API_KEY) {
  console.error("Missing env variables");
  process.exit(1);
}

// =========================
// ÉQUIPES
// =========================

const MAIN_TEAMS = new Set([
  "Barcelona",
  "Real Madrid",
  "Arsenal",
  "Manchester City",
  "Inter",
  "Napoli",
  "Bayern Munich",
  "Paris Saint Germain",
  "Marseille",
]);

const SECONDARY_TEAMS = new Set([
  "Liverpool",
  "Chelsea",
  "Manchester United",
  "Tottenham",
  "Juventus",
  "AC Milan",
  "AS Roma",
  "Borussia Dortmund",
  "Benfica",
  "Porto",
  "Ajax",
  "Atletico Madrid",
  "Lens",
  "Monaco",
  "Lille",
  "Lyon",
  "Newcastle",
  "Atalanta",
  "RB Leipzig",
  "Bayer Leverkusen",
  "PSV Eindhoven",
  "Feyenoord",
  "Sporting CP",
  "Celtic",
  "Rangers",
]);

// =========================
// STATE
// =========================

let nextCheckTimestamp = 0;

const alerted15 = new Set<number>();
const alertedOver = new Set<number>();

// =========================
// UTILS
// =========================

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { "x-apisports-key": API_KEY } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      }
    ).on("error", reject);
  });
}

function sendTelegram(message: string) {
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
  });

  const req = https.request(
    {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
    },
    () => {}
  );

  req.write(body);
  req.end();
}

function getMsUntil(date: string) {
  return new Date(date).getTime() - Date.now();
}

function isTracked(home: string, away: string) {
  return (
    MAIN_TEAMS.has(home) ||
    MAIN_TEAMS.has(away) ||
    SECONDARY_TEAMS.has(home) ||
    SECONDARY_TEAMS.has(away)
  );
}

// =========================
// MATCH DU JOUR
// =========================

async function getMatchesToday() {
  const today = new Date().toISOString().slice(0, 10);

  const data = await fetchJson(
    `https://v3.football.api-sports.io/fixtures?date=${today}`
  );

  return data.response
    .map((m: any) => {
      const home = m.teams.home.name;
      const away = m.teams.away.name;

      if (!isTracked(home, away)) return null;

      return {
        id: m.fixture.id,
        home,
        away,
        date: m.fixture.date,
      };
    })
    .filter(Boolean);
}

// =========================
// SCAN ULTRA ECO
// =========================

async function scan(): Promise<number> {
  try {
    const now = Date.now();

    // ⏱️ Attente planifiée
    if (nextCheckTimestamp && now < nextCheckTimestamp) {
      return nextCheckTimestamp - now;
    }

    const matches = await getMatchesToday();

    if (!matches.length) {
      console.log("Aucun match aujourd'hui");
      return 6 * 60 * 60 * 1000;
    }

    const future = matches
      .map((m) => ({ ...m, ms: getMsUntil(m.date) }))
      .filter((m) => m.ms > 0)
      .sort((a, b) => a.ms - b.ms);

    if (!future.length) {
      return 6 * 60 * 60 * 1000;
    }

    const next = future[0];
    const minutes = Math.round(next.ms / 60000);

    console.log(`Prochain match: ${next.home} vs ${next.away} dans ${minutes} min`);

    // =========================
    // PLANIFICATION INTELLIGENTE
    // =========================

    if (next.ms > 60 * 60 * 1000) {
      nextCheckTimestamp = Date.now() + (next.ms - 60 * 60 * 1000);
      return nextCheckTimestamp - now;
    }

    if (next.ms > 10 * 60 * 1000) {
      nextCheckTimestamp = Date.now() + (next.ms - 10 * 60 * 1000);
      return nextCheckTimestamp - now;
    }

    if (next.ms > 0) {
      nextCheckTimestamp = Date.now() + next.ms;
      return nextCheckTimestamp - now;
    }

    // =========================
    // MATCH LIVE
    // =========================

    console.log("MATCH LIVE");

    const live = await fetchJson(
      "https://v3.football.api-sports.io/fixtures?live=all"
    );

    for (const m of live.response) {
      const home = m.teams.home.name;
      const away = m.teams.away.name;

      if (!isTracked(home, away)) continue;

      const id = m.fixture.id;
      const minute = m.fixture.status.elapsed;
      const goals = m.goals;

      if (!minute) continue;

      // 🕒 15 min 0-0
      if (
        minute >= 15 &&
        goals.home === 0 &&
        goals.away === 0 &&
        !alerted15.has(id)
      ) {
        sendTelegram(`🕒 15' 0-0\n${home} vs ${away}`);
        alerted15.add(id);
      }

      // ⚡ Over 1.5
      if (
        minute >= 20 &&
        minute <= 70 &&
        goals.home + goals.away === 1 &&
        !alertedOver.has(id)
      ) {
        sendTelegram(
          `⚡ Over 1.5 probable\n${home} vs ${away} (${minute}')`
        );
        alertedOver.add(id);
      }
    }

    return 5 * 60 * 1000;
  } catch (e) {
    console.log("Erreur:", e);
    return 15 * 60 * 1000;
  }
}

// =========================
// LOOP
// =========================

async function main() {
  console.log("Bot lancé");

  while (true) {
    const sleep = await scan();
    console.log(`Prochain check dans ${Math.round(sleep / 60000)} min`);
    await new Promise((r) => setTimeout(r, sleep));
  }
}

main();