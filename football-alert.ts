import https from "node:https";
import http from "node:http";

const TELEGRAM_TOKEN = process.env["TELEGRAM_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
const API_KEY = process.env["API_FOOTBALL_KEY"];

if (!TELEGRAM_TOKEN || !CHAT_ID || !API_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

const MAIN_TEAMS = new Set([
  "Barcelona",
  "Real Madrid",
  "Arsenal",
  "Manchester City",
  "Inter",
  "Napoli",
  "Bayern Munich",
  "Paris Saint Germain",
  "Marseille"
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
  "Ajax"
]);

const alerted15 = new Set<number>();
const alertedPressure = new Set<number>();
const alertedOver = new Set<number>();

type Stat = { type: string; value: number | string | null };

function fetchJson(url: string, headers: Record<string,string>): Promise<any> {
  return new Promise((resolve,reject)=>{
    const lib = url.startsWith("https") ? https : http;

    const req = lib.get(url,{headers},res=>{
      let body="";
      res.on("data",(c:Buffer)=>body+=c.toString());
      res.on("end",()=>resolve(JSON.parse(body)));
    });

    req.on("error",reject);
  });
}

function sendTelegram(message:string){
  return new Promise((resolve)=>{
    const body = JSON.stringify({chat_id:CHAT_ID,text:message});

    const req = https.request({
      hostname:"api.telegram.org",
      path:`/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Content-Length":Buffer.byteLength(body)
      }
    },res=>{
      res.resume();
      res.on("end",resolve);
    });

    req.write(body);
    req.end();
  });
}

function getStat(stats:Stat[],name:string){
  const s = stats.find(x=>x.type===name);
  const v = s?.value;

  if(typeof v==="string"){
    const p=parseInt(v.replace("%",""),10);
    return Number.isNaN(p)?0:p;
  }

  return v ?? 0;
}

async function scan(){

  const headers = {"x-apisports-key":API_KEY};

  const live = await fetchJson(
    "https://v3.football.api-sports.io/fixtures?live=all",
    headers
  );

  const fixtures = live.response ?? [];

  for(const match of fixtures){

    const fixture = match.fixture;
    const teams = match.teams;
    const goals = match.goals;

    const minute = fixture.status.elapsed;
    if(minute===null) continue;

    const id = fixture.id;

    const home = teams.home.name;
    const away = teams.away.name;

    const homeGoals = goals.home ?? 0;
    const awayGoals = goals.away ?? 0;

    const isMain =
      MAIN_TEAMS.has(home) || MAIN_TEAMS.has(away);

    const isSecondary =
      SECONDARY_TEAMS.has(home) || SECONDARY_TEAMS.has(away);

    if(!isMain && !isSecondary) continue;

    const statsData = await fetchJson(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
      headers
    );

    const statsHome = statsData.response?.[0]?.statistics ?? [];
    const statsAway = statsData.response?.[1]?.statistics ?? [];

    const shots =
      getStat(statsHome,"Total Shots") +
      getStat(statsAway,"Total Shots");

    const onTarget =
      getStat(statsHome,"Shots on Goal") +
      getStat(statsAway,"Shots on Goal");

    const corners =
      getStat(statsHome,"Corner Kicks") +
      getStat(statsAway,"Corner Kicks");

    const dangerous =
      getStat(statsHome,"Dangerous Attacks") +
      getStat(statsAway,"Dangerous Attacks");

    /* ---------------------------
       1️⃣ NOTIF 15 MIN 0-0
    --------------------------- */

    if(
      isMain &&
      minute >=15 &&
      homeGoals===0 &&
      awayGoals===0 &&
      !alerted15.has(id)
    ){

      await sendTelegram(
        `🕒 15' 0-0\n${home} vs ${away}`
      );

      alerted15.add(id);
    }

    /* ---------------------------
       2️⃣ PRESSION 0-0
    --------------------------- */

    if(
      minute>=15 &&
      minute<=35 &&
      homeGoals===0 &&
      awayGoals===0 &&
      !alertedPressure.has(id)
    ){

      if(
        onTarget>=3 ||
        corners>=5 ||
        dangerous>=35
      ){

        const level =
          onTarget>=4 || dangerous>=40
          ? "🔥 But imminent"
          : "🌡️ But possible";

        await sendTelegram(
`${level}
${home} vs ${away}
${minute}' • 0-0
🎯 ${onTarget} • 🚩 ${corners} • ⚔️ ${dangerous}`
        );

        alertedPressure.add(id);
      }
    }

    /* ---------------------------
       3️⃣ OVER 1.5
    --------------------------- */

    if(
      minute>=20 &&
      minute<=70 &&
      !alertedOver.has(id)
    ){

      const totalGoals = homeGoals + awayGoals;

      if(totalGoals===1){

        if(
          onTarget>=4 ||
          corners>=5 ||
          dangerous>=40
        ){

          await sendTelegram(
`⚡ Over 1.5 probable
${home} vs ${away}
${minute}' • ${homeGoals}-${awayGoals}
🎯 ${onTarget} • 🚩 ${corners} • ⚔️ ${dangerous}`
          );

          alertedOver.add(id);
        }
      }
    }

  }
}

async function main(){

  console.log("Bot started");

  while(true){

    await scan();

    await new Promise(r=>setTimeout(r,60000));

  }
}

main();
