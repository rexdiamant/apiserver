import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import {
  PlayCoinFlipBody,
  PlayCoinFlipResponse,
  PlayDiceBody,
  PlayDiceResponse,
  PlaySlotsBody,
  PlaySlotsResponse,
  PlayRouletteBody,
  PlayRouletteResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const WIN_POINTS = 10;
const BIG_WIN_POINTS = 25;

async function getPlayerBySession(sessionId: string) {
  const [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  return player;
}

router.post("/gambling/coin-flip", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const parsed = PlayCoinFlipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { bet, choice } = parsed.data;
  const player = await getPlayerBySession(sessionId);

  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  if (bet <= 0 || bet > player.dailyCreditsRemaining) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }

  // Gewinnchance erhöht auf 55%
  const outcome = Math.random() < 0.55 ? choice : (choice === "heads" ? "tails" : "heads");
  const won = outcome === choice;
  const creditsChange = won ? bet : -bet;
  const pointsEarned = won ? WIN_POINTS : 0;

  const newCredits = player.credits + creditsChange;
  const newPoints = player.points + pointsEarned;
  // Gewinne werden zum Tageslimit dazugezählt; Verluste ziehen ab
  const newDailyRemaining = won
    ? player.dailyCreditsRemaining  // Einsatz zurückbekommen + Gewinn → kein Abzug
    : player.dailyCreditsRemaining - bet;
  const newBiggestWin = won && bet > player.biggestWin ? bet : player.biggestWin;

  await db.update(playersTable).set({
    credits: newCredits,
    points: newPoints,
    dailyCreditsRemaining: newDailyRemaining,
    gamesPlayed: player.gamesPlayed + 1,
    biggestWin: newBiggestWin,
  }).where(eq(playersTable.sessionId, sessionId));

  const outcomeName = outcome === "heads" ? "Kopf" : "Zahl";
  res.json(PlayCoinFlipResponse.parse({
    won,
    creditsChange,
    pointsEarned,
    newCredits,
    newPoints,
    message: won ? `Es ist ${outcomeName}! Du gewinnst ${bet} Credits!` : `Es ist ${outcomeName}! Du verlierst ${bet} Credits.`,
    outcome,
  }));
});

router.post("/gambling/dice", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const parsed = PlayDiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { bet, prediction } = parsed.data;
  if (prediction < 1 || prediction > 6) {
    res.status(400).json({ error: "Vorhersage muss zwischen 1 und 6 liegen." });
    return;
  }

  const player = await getPlayerBySession(sessionId);
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  if (bet <= 0 || bet > player.dailyCreditsRemaining) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }

  // Gewinnchance auf ~25% erhöht (von ~16.7%) - Bias Richtung Vorhersage
  let outcome: number;
  if (Math.random() < 0.25) {
    outcome = prediction;
  } else {
    const others = [1, 2, 3, 4, 5, 6].filter(n => n !== prediction);
    outcome = others[Math.floor(Math.random() * others.length)];
  }

  const won = outcome === prediction;
  const creditsChange = won ? bet * 4 : -bet;
  const pointsEarned = won ? BIG_WIN_POINTS : 0;

  const newCredits = player.credits + creditsChange;
  const newPoints = player.points + pointsEarned;
  const newDailyRemaining = won
    ? player.dailyCreditsRemaining  // kein Abzug bei Gewinn
    : player.dailyCreditsRemaining - bet;
  const newBiggestWin = won && bet * 4 > player.biggestWin ? bet * 4 : player.biggestWin;

  await db.update(playersTable).set({
    credits: newCredits,
    points: newPoints,
    dailyCreditsRemaining: newDailyRemaining,
    gamesPlayed: player.gamesPlayed + 1,
    biggestWin: newBiggestWin,
  }).where(eq(playersTable.sessionId, sessionId));

  res.json(PlayDiceResponse.parse({
    won,
    creditsChange,
    pointsEarned,
    newCredits,
    newPoints,
    message: won ? `Gewürfelt: ${outcome}! Du gewinnst ${bet * 4} Credits!` : `Gewürfelt: ${outcome}. Du brauchtest ${prediction}. Verlust: ${bet} Credits.`,
    outcome: String(outcome),
  }));
});

const SLOT_SYMBOLS = ["Kirsche", "Zitrone", "Orange", "Traube", "Sieben", "Diamant"];
const SLOT_MULTIPLIERS: Record<string, number> = {
  Kirsche: 2,
  Zitrone: 2,
  Orange: 3,
  Traube: 4,
  Sieben: 10,
  Diamant: 20,
};

router.post("/gambling/slots", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const parsed = PlaySlotsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { bet } = parsed.data;
  const player = await getPlayerBySession(sessionId);
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  if (bet <= 0 || bet > player.dailyCreditsRemaining) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }

  // Gewinnchance erhöht: 20% Jackpot (alle 3 gleich), 35% zwei gleich
  const rand = Math.random();
  let reels: string[];
  if (rand < 0.20) {
    // Jackpot - alle 3 gleich
    const sym = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    reels = [sym, sym, sym];
  } else if (rand < 0.55) {
    // Zwei gleich
    const sym = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const other = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const positions = Math.floor(Math.random() * 3);
    if (positions === 0) reels = [sym, sym, other];
    else if (positions === 1) reels = [sym, other, sym];
    else reels = [other, sym, sym];
  } else {
    // Kein Match
    reels = [
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
      SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    ];
    // Sicherstellen, dass nicht versehentlich alle gleich
    while (reels[0] === reels[1] && reels[1] === reels[2]) {
      reels[2] = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    }
  }

  const allSame = reels[0] === reels[1] && reels[1] === reels[2];
  const twoSame = reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2];

  let multiplier = 0;
  if (allSame) {
    multiplier = SLOT_MULTIPLIERS[reels[0]] || 2;
  } else if (twoSame) {
    multiplier = 1;
  }

  const won = multiplier > 0;
  const creditsChange = won ? bet * multiplier - bet : -bet;
  const pointsEarned = allSame ? BIG_WIN_POINTS : (twoSame ? WIN_POINTS : 0);

  const newCredits = player.credits + creditsChange;
  const newPoints = player.points + pointsEarned;
  const newDailyRemaining = won
    ? player.dailyCreditsRemaining  // kein Abzug bei Gewinn
    : player.dailyCreditsRemaining - bet;
  const winAmount = won ? bet * multiplier : 0;
  const newBiggestWin = winAmount > player.biggestWin ? winAmount : player.biggestWin;

  await db.update(playersTable).set({
    credits: newCredits,
    points: newPoints,
    dailyCreditsRemaining: newDailyRemaining,
    gamesPlayed: player.gamesPlayed + 1,
    biggestWin: newBiggestWin,
  }).where(eq(playersTable.sessionId, sessionId));

  let message = "";
  if (allSame) {
    message = `JACKPOT! Drei ${reels[0]}! Du gewinnst ${bet * multiplier} Credits!`;
  } else if (twoSame) {
    message = `Zwei gleiche! Du bekommst deinen Einsatz zurück!`;
  } else {
    message = `Keine Übereinstimmung. Du verlierst ${bet} Credits.`;
  }

  res.json(PlaySlotsResponse.parse({
    won,
    creditsChange,
    pointsEarned,
    newCredits,
    newPoints,
    message,
    outcome: reels.join("-"),
    reels,
  }));
});

const ROULETTE_RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

router.post("/gambling/roulette", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const parsed = PlayRouletteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { bet, betType, number } = parsed.data;
  const player = await getPlayerBySession(sessionId);
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  if (bet <= 0 || bet > player.dailyCreditsRemaining) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }

  const spin = Math.floor(Math.random() * 37);
  const isRed = ROULETTE_RED_NUMBERS.includes(spin);
  const isBlack = !isRed && spin !== 0;
  const isEven = spin !== 0 && spin % 2 === 0;
  const isOdd = spin !== 0 && spin % 2 === 1;

  let won = false;
  let multiplier = 1;

  if (betType === "red" && isRed) { won = true; multiplier = 2; }
  else if (betType === "black" && isBlack) { won = true; multiplier = 2; }
  else if (betType === "even" && isEven) { won = true; multiplier = 2; }
  else if (betType === "odd" && isOdd) { won = true; multiplier = 2; }
  else if (betType === "number" && number !== null && number !== undefined && spin === number) {
    won = true; multiplier = 36;
  }

  const creditsChange = won ? bet * (multiplier - 1) : -bet;
  const pointsEarned = won ? (multiplier >= 36 ? BIG_WIN_POINTS * 2 : WIN_POINTS) : 0;

  const newCredits = player.credits + creditsChange;
  const newPoints = player.points + pointsEarned;
  const newDailyRemaining = won
    ? player.dailyCreditsRemaining  // kein Abzug bei Gewinn
    : player.dailyCreditsRemaining - bet;
  const winAmount = won ? bet * multiplier : 0;
  const newBiggestWin = winAmount > player.biggestWin ? winAmount : player.biggestWin;

  await db.update(playersTable).set({
    credits: newCredits,
    points: newPoints,
    dailyCreditsRemaining: newDailyRemaining,
    gamesPlayed: player.gamesPlayed + 1,
    biggestWin: newBiggestWin,
  }).where(eq(playersTable.sessionId, sessionId));

  const color = spin === 0 ? "grün" : (isRed ? "rot" : "schwarz");
  const message = won
    ? `Die Kugel landete auf ${spin} (${color})! Du gewinnst ${bet * (multiplier - 1)} Credits!`
    : `Die Kugel landete auf ${spin} (${color}). Du verlierst ${bet} Credits.`;

  res.json(PlayRouletteResponse.parse({
    won,
    creditsChange,
    pointsEarned,
    newCredits,
    newPoints,
    message,
    outcome: `${spin} (${color})`,
  }));
});

// =================== PFERDERENNEN ===================
interface Horse {
  id: number;
  name: string;
  emoji: string;
  winChance: number; // 0-1
  multiplier: number;
}

const HORSES: Horse[] = [
  { id: 1, name: "Blitz",   emoji: "⚡", winChance: 0.35, multiplier: 2 },
  { id: 2, name: "Sturm",   emoji: "🌪️", winChance: 0.25, multiplier: 3 },
  { id: 3, name: "Donner",  emoji: "🌩️", winChance: 0.16, multiplier: 4 },
  { id: 4, name: "König",   emoji: "👑", winChance: 0.11, multiplier: 6 },
  { id: 5, name: "Feuer",   emoji: "🔥", winChance: 0.07, multiplier: 9 },
  { id: 6, name: "Phantom", emoji: "👻", winChance: 0.04, multiplier: 15 },
  { id: 7, name: "Meteor",  emoji: "☄️", winChance: 0.015, multiplier: 30 },
  { id: 8, name: "Legende", emoji: "🏅", winChance: 0.005, multiplier: 60 },
];

function pickWinner(): Horse {
  const r = Math.random();
  let cumulative = 0;
  for (const h of HORSES) {
    cumulative += h.winChance;
    if (r < cumulative) return h;
  }
  return HORSES[0];
}

router.get("/gambling/horses", (_req, res): void => {
  res.json(HORSES.map(h => ({
    id: h.id, name: h.name, emoji: h.emoji,
    winChance: h.winChance, multiplier: h.multiplier,
  })));
});

router.post("/gambling/horse-race", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const { bet, horseId } = req.body ?? {};
  const betAmt = parseInt(bet);
  const hId = parseInt(horseId);

  if (isNaN(betAmt) || betAmt <= 0) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }
  const chosenHorse = HORSES.find(h => h.id === hId);
  if (!chosenHorse) {
    res.status(400).json({ error: "Ungültiges Pferd." });
    return;
  }

  const player = await getPlayerBySession(sessionId);
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }
  if (betAmt > player.dailyCreditsRemaining) {
    res.status(400).json({ error: "Ungültiger Einsatz." });
    return;
  }

  const winner = pickWinner();
  const won = winner.id === chosenHorse.id;
  const creditsChange = won ? betAmt * (chosenHorse.multiplier - 1) : -betAmt;
  const pointsEarned = won ? (chosenHorse.multiplier >= 10 ? BIG_WIN_POINTS * 2 : WIN_POINTS) : 0;

  const newCredits = player.credits + creditsChange;
  const newPoints = player.points + pointsEarned;
  const newDailyRemaining = won ? player.dailyCreditsRemaining : player.dailyCreditsRemaining - betAmt;
  const winAmount = won ? betAmt * chosenHorse.multiplier : 0;
  const newBiggestWin = winAmount > player.biggestWin ? winAmount : player.biggestWin;

  await db.update(playersTable).set({
    credits: newCredits,
    points: newPoints,
    dailyCreditsRemaining: newDailyRemaining,
    gamesPlayed: player.gamesPlayed + 1,
    biggestWin: newBiggestWin,
  }).where(eq(playersTable.sessionId, sessionId));

  const message = won
    ? `${winner.emoji} ${winner.name} gewinnt! Du gewinnst ${betAmt * (chosenHorse.multiplier - 1)} Credits!`
    : `${winner.emoji} ${winner.name} gewinnt das Rennen. Dein Pferd ${chosenHorse.emoji} ${chosenHorse.name} verliert.`;

  // Build finishing order (winner first, rest randomized)
  const rest = HORSES.filter(h => h.id !== winner.id).sort(() => Math.random() - 0.5);
  const finishOrder = [winner, ...rest].map(h => `${h.emoji}${h.name}`).join("|");

  res.json({
    won,
    creditsChange,
    pointsEarned,
    newCredits,
    newPoints,
    message,
    outcome: `${winner.emoji} ${winner.name}`,
    winnerId: winner.id,
    finishOrder,
  });
});

export default router;
