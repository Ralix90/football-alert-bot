import https from "node:https";
import http from "node:http";

const TELEGRAM_TOKEN = process.env["TELEGRAM_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
const API_KEY = process.env["API_FOOTBALL_KEY"];

if (!TELEGRAM_TOKEN || !CHAT_ID || !API_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

// true = envoie une alerte test au démarrage
const TEST_FORCE_ALERT = false;

// true = surveille tous les matchs
const WATCH_ALL_MATCHES = false;

// Anti-spam global
const PRO_ALERT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_PRO_ALERTS_PER_WINDOW = 3;

// Equipes principales : notif 15' + notif premium
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

// Equipes secondaires : seulement notif premium
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

const alerted15 = new Set<number>();
const alertedPressure = new Set<number>();
const alertedOver = new Set<number>();

const proAlertTimestamps: number[] = [];

let testAlertSent = false;

type Stat = {
  type: string;
  value: number | string | null;
};

type MatchSnapshot = {
  minute: number;
  totalShots: number;
  totalOnTarget: number;
  totalCorners: number;
  totalDangerousAttacks: number;
  scoreHome: number;
  scoreAway: number;
  updatedAt: number;
};

const lastSnapshots = new Map<number, MatchSnapshot>();

function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
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

function getStat(stats: Stat[], name: string): number {
  const s = stats.find((x) => x.type === name);
  const v = s?.value;

  if (typeof v === "string") {
    const parsed = parseInt(v.replace("%", ""), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return v ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildPressureScore(params: {
  minute: number;
  totalShots: number;
  totalOnTarget: number;
  totalCorners: number;
  dangerousAttacks: number;
  possessionHome: number;
  possessionAway: number;
  momentumScore: number;
}): number {
  const {
    minute,
    totalShots,
    totalOnTarget,
    totalCorners,
    dangerousAttacks,
    possessionHome,
    possessionAway,
    momentumScore,
  } = params;

  let score = 0;

  score += totalShots * 0.7;
  score += totalOnTarget * 3.5;
  score += totalCorners * 1.5;
  score += dangerousAttacks * 0.17;
  score += momentumScore * 1.4;

  const possessionGap = Math.abs(possessionHome - possessionAway);
  if (possessionGap >= 10) score += 1.0;
  if (possessionGap >= 18) score += 1.0;

  if (minute >= 20 && minute <= 30) score += 2.0;
  if (minute > 30 && minute <= 35) score += 1.0;
  if (minute >= 45 && minute <= 65) score += 1.0; // utile pour over 1.5

  if (totalOnTarget >= 2 && totalCorners >= 3) score += 2.0;
  if (totalOnTarget >= 3 && dangerousAttacks >= 25) score += 2.5;
  if (totalCorners >= 5 && dangerousAttacks >= 30) score += 2.0;
  if (totalShots >= 8 && totalOnTarget >= 3) score += 1.5;

  return Number(score.toFixed(1));
}

function getMomentumLabel(momentumScore: number): string {
  if (momentumScore >= 3.5) return "🚀 fort";
  if (momentumScore >= 2) return "📈 bon";
  return "➖ neutre";
}

function computeMomentum(current: MatchSnapshot, previous?: MatchSnapshot): number {
  if (!previous) return 0;

  const minuteDiff = Math.max(1, current.minute - previous.minute);

  const deltaShots = current.totalShots - previous.totalShots;
  const deltaOnTarget = current.totalOnTarget - previous.totalOnTarget;
  const deltaCorners = current.totalCorners - previous.totalCorners;
  const deltaDangerous =
    current.totalDangerousAttacks - previous.totalDangerousAttacks;

  let score = 0;
  score += deltaShots * 0.5;
  score += deltaOnTarget * 2.2;
  score += deltaCorners * 1.0;
  score += deltaDangerous * 0.12;

  // si tout ça arrive vite, on bonifie
  if (minuteDiff <= 2) score += 0.8;

  return Number(Math.max(0, score).toFixed(1));
}

function getGoalProbabilityPercent(params: {
  pressureScore: number;
  totalOnTarget: number;
  totalCorners: number;
  totalDangerousAttacks: number;
  minute: number;
  totalGoals: number;
}): number {
  const {
    pressureScore,
    totalOnTarget,
    totalCorners,
    totalDangerousAttacks,
    minute,
    totalGoals,
  } = params;

  let probability = 0;

  if (totalGoals === 0) {
    probability = 28 + pressureScore * 2.4;
    probability += totalOnTarget * 2;
    probability += totalCorners * 1.2;
    probability += totalDangerousAttacks * 0.15;

    if (minute >= 20 && minute <= 35) probability += 6;
  } else if (totalGoals === 1) {
    probability = 22 + pressureScore * 2.1;
    probability += totalOnTarget * 2.3;
    probability += totalCorners * 1.3;
    probability += totalDangerousAttacks * 0.16;

    if (minute >= 25 && minute <= 65) probability += 5;
    if (minute > 65) probability -= 8;
  }

  return Math.round(clamp(probability, 5, 95));
}

function getQualityOutOf10(params: {
  pressureScore: number;
  totalOnTarget: number;
  totalCorners: number;
  totalDangerousAttacks: number;
  momentumScore: number;
}): number {
  const {
    pressureScore,
    totalOnTarget,
    totalCorners,
    totalDangerousAttacks,
    momentumScore,
  } = params;

  let score =
    pressureScore * 0.28 +
    totalOnTarget * 0.7 +
    totalCorners * 0.25 +
    totalDangerousAttacks * 0.03 +
    momentumScore * 0.8;

  score = clamp(score, 1, 10);
  return Math.round(score);
}

function getPressureTitle(pressureScore: number, probability: number): string {
  if (pressureScore >= 20 || probability >= 78) return "🔥 But imminent";
  if (pressureScore >= 12 || probability >= 58) return "🌡️ But possible";
  return "🧊 Match froid";
}

function canSendProAlert(): boolean {
  const now = Date.now();

  while (proAlertTimestamps.length > 0 && now - proAlertTimestamps[0]! > PRO_ALERT_WINDOW_MS) {
    proAlertTimestamps.shift();
  }

  return proAlertTimestamps.length < MAX_PRO_ALERTS_PER_WINDOW;
}

function markProAlertSent(): void {
  proAlertTimestamps.push(Date.now());
}

function pruneSnapshots(): void {
  const now = Date.now();
  for (const [fixtureId, snapshot] of lastSnapshots.entries()) {
    if (now - snapshot.updatedAt > 3 * 60 * 60 * 1000) {
      lastSnapshots.delete(fixtureId);
    }
  }
}

async function sendForcedTestAlert() {
  if (testAlertSent) return;

  const message = [
    "🧪 Test bot premium",
    "Barcelona vs Marseille",
    "24' • 0-0",
    "🔥 But imminent • 79%",
    "🎯 3 • 🚩 4 • ⚔️ 31 • 🚀 fort • ⭐ 8/10",
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

    pruneSnapshots();

    const headers = { "x-apisports-key": API_KEY };

    const live = await fetchJson(
      "https://v3.football.api-sports.io/fixtures?live=all",
      headers
    );

    const fixtures = live.response ?? [];
    console.log(`[${new Date().toISOString()}] Live fixtures: ${fixtures.length}`);

    for (const match of fixtures) {
      const fixture = match.fixture;
      const teams = match.teams;
      const goals = match.goals;

      const minute: number | null = fixture?.status?.elapsed ?? null;
      if (minute === null) continue;

      const id: number = fixture.id;
      const home: string = teams.home.name;
      const away: string = teams.away.name;

      const homeGoals = goals.home ?? 0;
      const awayGoals = goals.away ?? 0;
      const totalGoals = homeGoals + awayGoals;

      const isMain = MAIN_TEAMS.has(home) || MAIN_TEAMS.has(away);
      const isSecondary = SECONDARY_TEAMS.has(home) || SECONDARY_TEAMS.has(away);

      if (!WATCH_ALL_MATCHES && !isMain && !isSecondary) continue;

      const statsData = await fetchJson(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        headers
      );

      const statsHome = statsData.response?.[0]?.statistics ?? [];
      const statsAway = statsData.response?.[1]?.statistics ?? [];

      const totalShots =
        getStat(statsHome, "Total Shots") + getStat(statsAway, "Total Shots");
      const totalOnTarget =
        getStat(statsHome, "Shots on Goal") + getStat(statsAway, "Shots on Goal");
      const totalCorners =
        getStat(statsHome, "Corner Kicks") + getStat(statsAway, "Corner Kicks");
      const totalDangerousAttacks =
        getStat(statsHome, "Dangerous Attacks") +
        getStat(statsAway, "Dangerous Attacks");
      const possessionHome = getStat(statsHome, "Ball Possession");
      const possessionAway = getStat(statsAway, "Ball Possession");

      const currentSnapshot: MatchSnapshot = {
        minute,
        totalShots,
        totalOnTarget,
        totalCorners,
        totalDangerousAttacks,
        scoreHome: homeGoals,
        scoreAway: awayGoals,
        updatedAt: Date.now(),
      };

      const previousSnapshot = lastSnapshots.get(id);
      const momentumScore = computeMomentum(currentSnapshot, previousSnapshot);
      lastSnapshots.set(id, currentSnapshot);

      const pressureScore = buildPressureScore({
        minute,
        totalShots,
        totalOnTarget,
        totalCorners,
        dangerousAttacks: totalDangerousAttacks,
        possessionHome,
        possessionAway,
        momentumScore,
      });

      const probability = getGoalProbabilityPercent({
        pressureScore,
        totalOnTarget,
        totalCorners,
        totalDangerousAttacks,
        minute,
        totalGoals,
      });

      const matchQuality = getQualityOutOf10({
        pressureScore,
        totalOnTarget,
        totalCorners,
        totalDangerousAttacks,
        momentumScore,
      });

      const momentumLabel = getMomentumLabel(momentumScore);

      // 1) NOTIF 15 MIN 0-0 uniquement pour les principales
      if (
        isMain &&
        minute >= 15 &&
        homeGoals === 0 &&
        awayGoals === 0 &&
        !alerted15.has(id)
      ) {
        await sendTelegram(`🕒 15' 0-0\n${home} vs ${away}`);
        alerted15.add(id);
      }

      // 2) NOTIF PRESSION / BUT PROBABLE sur 0-0
      if (
        minute >= 15 &&
        minute <= 35 &&
        homeGoals === 0 &&
        awayGoals === 0 &&
        !alertedPressure.has(id)
      ) {
        const enoughActivity =
          totalShots >= 4 ||
          totalOnTarget >= 2 ||
          totalCorners >= 3 ||
          totalDangerousAttacks >= 20;

        const notTooDead = totalShots >= 3;
        const notTooWild = totalShots <= 16;

        if (enoughActivity && notTooDead && notTooWild && canSendProAlert()) {
          const shouldAlertMain =
            pressureScore >= 12 ||
            totalOnTarget >= 3 ||
            totalCorners >= 5 ||
            totalDangerousAttacks >= 35 ||
            (totalOnTarget >= 2 && totalCorners >= 4) ||
            probability >= 58 ||
            momentumScore >= 2.5;

          const shouldAlertSecondary =
            pressureScore >= 15 ||
            totalOnTarget >= 4 ||
            totalCorners >= 6 ||
            totalDangerousAttacks >= 40 ||
            probability >= 66 ||
            momentumScore >= 3;

          const shouldAlert = isMain ? shouldAlertMain : shouldAlertSecondary;

          if (shouldAlert) {
            const title = getPressureTitle(pressureScore, probability);

            const message = [
              `${title} • ${probability}%`,
              `${home} vs ${away}`,
              `${minute}' • 0-0`,
              `🎯 ${totalOnTarget} • 🚩 ${totalCorners} • ⚔️ ${totalDangerousAttacks} • ${momentumLabel} • ⭐ ${matchQuality}/10`,
            ].join("\n");

            await sendTelegram(message);
            alertedPressure.add(id);
            markProAlertSent();
          }
        }
      }

      // 3) NOTIF OVER 1.5 sur 1-0 / 0-1 entre 20 et 70
      if (
        minute >= 20 &&
        minute <= 70 &&
        totalGoals === 1 &&
        !alertedOver.has(id)
      ) {
        const enoughForOver =
          totalOnTarget >= 4 ||
          totalCorners >= 5 ||
          totalDangerousAttacks >= 40 ||
          pressureScore >= 15 ||
          probability >= 64 ||
          momentumScore >= 2.8;

        if (enoughForOver && canSendProAlert()) {
          const overTitle =
            probability >= 78 || pressureScore >= 20
              ? "🔥 Over 1.5 chaud"
              : "⚡ Over 1.5 probable";

          const message = [
            `${overTitle} • ${probability}%`,
            `${home} vs ${away}`,
            `${minute}' • ${homeGoals}-${awayGoals}`,
            `🎯 ${totalOnTarget} • 🚩 ${totalCorners} • ⚔️ ${totalDangerousAttacks} • ${momentumLabel} • ⭐ ${matchQuality}/10`,
          ].join("\n");

          await sendTelegram(message);
          alertedOver.add(id);
          markProAlertSent();
        }
      }
    }
  } catch (e) {
    console.error("Scan error:", (e as Error).message);
  }
}

async function main() {
  console.log("Bot started");

  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, 60000));
  }
}

main();
