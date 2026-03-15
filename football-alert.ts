import https from "node:https";
import http from "node:http";

const TELEGRAM_TOKEN = process.env["TELEGRAM_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
const API_KEY = process.env["API_FOOTBALL_KEY"];

// false = vrai mode live
// true = envoie une alerte de test au démarrage
const TEST_FORCE_ALERT = false;

// false = surveille seulement tes équipes favorites
// true = surveille tous les matchs
const WATCH_ALL_MATCHES = false;

if (!TELEGRAM_TOKEN || !CHAT_ID || !API_KEY) {
  console.error(
    "Missing required env vars: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, API_FOOTBALL_KEY"
  );
  process.exit(1);
}

const FAVORITE_TEAMS = new Set([
  "Barcelona",
  "Real Madrid",
  "Atletico Madrid",
  "Arsenal",
  "Manchester City",
  "Inter",
  "Napoli",
  "AC Milan",
  "Bayern Munich",
  "Borussia Dortmund",
  "Paris Saint Germain",
  "Lens",
  "Marseille",
]);

const alertedFixtures15 = new Set<number>();
const alertedFixturesPressure = new Set<number>();
let testAlertSent = false;

type Stat = {
  type: string;
  value: number | null;
};

function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;

    const req = lib.get(url, { headers }, (res) => {
      let body = "";

      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e}`));
        }
      });
    });

    req.on("error", reject);

    req.setTimeout(20000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

function sendTelegram(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = "";

        res.on("data", (chunk) => {
          responseBody += chunk.toString();
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Telegram error ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on("error", reject);

    req.setTimeout(15000, () => {
      req.destroy(new Error("Telegram request timeout"));
    });

    req.write(body);
    req.end();
  });
}

function getStatValue(stats: Stat[], statType: string): number {
  const stat = stats.find((s) => s.type === statType);
  const value = stat?.value;

  if (typeof value === "string") {
    const parsed = parseInt(value.replace("%", ""), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return value ?? 0;
}

function buildPressureScore(params: {
  minute: number;
  totalShots: number;
  totalOnTarget: number;
  totalCorners: number;
  dangerousAttacks: number;
  possessionHome: number;
  possessionAway: number;
}): number {
  const {
    minute,
    totalShots,
    totalOnTarget,
    totalCorners,
    dangerousAttacks,
    possessionHome,
    possessionAway,
  } = params;

  let score = 0;

  // base
  score += totalShots * 0.7;
  score += totalOnTarget * 3.4;
  score += totalCorners * 1.4;
  score += dangerousAttacks * 0.17;

  // domination / contrôle
  const possessionGap = Math.abs(possessionHome - possessionAway);
  if (possessionGap >= 10) score += 1.0;
  if (possessionGap >= 18) score += 1.0;

  // fenêtre chaude
  if (minute >= 20 && minute <= 30) score += 2.0;
  if (minute > 30 && minute <= 35) score += 1.0;

  // combos utiles
  if (totalOnTarget >= 2 && totalCorners >= 3) score += 2.0;
  if (totalOnTarget >= 3 && dangerousAttacks >= 25) score += 2.5;
  if (totalCorners >= 5 && dangerousAttacks >= 30) score += 2.0;
  if (totalShots >= 8 && totalOnTarget >= 3) score += 1.5;

  return Number(score.toFixed(1));
}

function getGoalProbabilityInfo(pressureScore: number): {
  title: string;
} {
  if (pressureScore >= 20) {
    return { title: "🔥 But imminent" };
  }

  if (pressureScore >= 12) {
    return { title: "🌡️ But possible" };
  }

  return { title: "🧊 Match froid" };
}

async function sendForcedTestAlert() {
  if (testAlertSent) return;

  const message = [
    "🧪 Test bot",
    "Barcelona vs Marseille",
    "24' • 0-0",
    "🔥 But imminent",
    "🎯 3 • 🚩 4 • ⚔️ 31",
  ].join("\n");

  await sendTelegram(message);
  testAlertSent = true;
}

async function scan() {
  try {
    if (TEST_FORCE_ALERT) {
      await sendForcedTestAlert();
      return;
    }

    const apiHeaders = { "x-apisports-key": API_KEY! };

    const liveData = (await fetchJson(
      "https://v3.football.api-sports.io/fixtures?live=all",
      apiHeaders
    )) as { response?: Array<Record<string, unknown>> };

    const fixtures = liveData.response ?? [];
    console.log(`[${new Date().toISOString()}] Live fixtures: ${fixtures.length}`);

    for (const match of fixtures) {
      const fixture = match["fixture"] as {
        id: number;
        status: { elapsed: number | null };
      };

      const teams = match["teams"] as {
        home: { name: string };
        away: { name: string };
      };

      const goals = match["goals"] as {
        home: number | null;
        away: number | null;
      };

      const fixtureId = fixture.id;
      const minute = fixture.status.elapsed;
      const home = teams.home.name;
      const away = teams.away.name;
      const scoreHome = goals.home ?? 0;
      const scoreAway = goals.away ?? 0;

      const isFavoriteMatch =
        FAVORITE_TEAMS.has(home) || FAVORITE_TEAMS.has(away);

      if (!WATCH_ALL_MATCHES && !isFavoriteMatch) continue;
      if (minute === null) continue;
      if (scoreHome !== 0 || scoreAway !== 0) continue;

      // NOTIF 1 : 15 MIN - on la garde absolument
      if (minute >= 15 && !alertedFixtures15.has(fixtureId)) {
        const message15 = [
          "🕒 15' 0-0",
          `${home} vs ${away}`,
        ].join("\n");

        await sendTelegram(message15);
        alertedFixtures15.add(fixtureId);
      }

      // NOTIF 2 : VERSION PRO
      if (minute < 15 || minute > 35) continue;
      if (alertedFixturesPressure.has(fixtureId)) continue;

      const statsData = (await fetchJson(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
        apiHeaders
      )) as {
        response?: Array<{
          statistics: Stat[];
        }>;
      };

      const statsResponse = statsData.response ?? [];
      if (statsResponse.length < 2) continue;

      const statsHome = statsResponse[0]!.statistics;
      const statsAway = statsResponse[1]!.statistics;

      const shotsHome = getStatValue(statsHome, "Total Shots");
      const shotsAway = getStatValue(statsAway, "Total Shots");
      const onTargetHome = getStatValue(statsHome, "Shots on Goal");
      const onTargetAway = getStatValue(statsAway, "Shots on Goal");
      const cornersHome = getStatValue(statsHome, "Corner Kicks");
      const cornersAway = getStatValue(statsAway, "Corner Kicks");
      const dangerousHome = getStatValue(statsHome, "Dangerous Attacks");
      const dangerousAway = getStatValue(statsAway, "Dangerous Attacks");
      const possessionHome = getStatValue(statsHome, "Ball Possession");
      const possessionAway = getStatValue(statsAway, "Ball Possession");

      const totalShots = shotsHome + shotsAway;
      const totalOnTarget = onTargetHome + onTargetAway;
      const totalCorners = cornersHome + cornersAway;
      const totalDangerousAttacks = dangerousHome + dangerousAway;

      // filtre anti-déchets
      const enoughActivity =
        totalShots >= 4 ||
        totalOnTarget >= 2 ||
        totalCorners >= 3 ||
        totalDangerousAttacks >= 20;

      const notTooDead = totalShots >= 3;
      const notTooWild = totalShots <= 16;

      if (!enoughActivity || !notTooDead || !notTooWild) continue;

      const pressureScore = buildPressureScore({
        minute,
        totalShots,
        totalOnTarget,
        totalCorners,
        dangerousAttacks: totalDangerousAttacks,
        possessionHome,
        possessionAway,
      });

      const shouldAlert =
        pressureScore >= 12 ||
        totalOnTarget >= 3 ||
        totalCorners >= 5 ||
        totalDangerousAttacks >= 35 ||
        (totalOnTarget >= 2 && totalCorners >= 4);

      if (!shouldAlert) continue;

      const goalProb = getGoalProbabilityInfo(pressureScore);

      const messagePressure = [
        goalProb.title,
        `${home} vs ${away}`,
        `${minute}' • 0-0`,
        `🎯 ${totalOnTarget} • 🚩 ${totalCorners} • ⚔️ ${totalDangerousAttacks}`,
      ].join("\n");

      await sendTelegram(messagePressure);
      alertedFixturesPressure.add(fixtureId);
    }
  } catch (e) {
    console.error("Scan error:", (e as Error).message);
  }
}

async function main() {
  console.log("Football alert bot started.");

  while (true) {
    await scan();
    console.log("Scan done — waiting 60s...");
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main();
