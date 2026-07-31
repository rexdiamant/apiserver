import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { GetPlayerResponse, DailyResetResponse, UpdateUsernameBody, UpdateUsernameResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const DAILY_CREDIT_ALLOWANCE = 500;
const USERNAMES = [
  "GoldRush", "VegasViper", "LuckyDuke", "NeonFox", "JackpotKing",
  "RollTheDice", "CasinoAce", "StarlightBet", "RoyalFlush", "HighRoller"
];

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

function getRandomUsername(): string {
  return USERNAMES[Math.floor(Math.random() * USERNAMES.length)] + Math.floor(Math.random() * 999);
}

router.get("/player", async (req, res): Promise<void> => {
  let sessionId = req.cookies?.["casino_session"];

  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    res.cookie("casino_session", sessionId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    });
  }

  const today = getTodayDate();
  let [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));

  if (!player) {
    const [newPlayer] = await db.insert(playersTable).values({
      sessionId,
      username: getRandomUsername(),
      credits: DAILY_CREDIT_ALLOWANCE,
      points: 0,
      dailyCreditsRemaining: DAILY_CREDIT_ALLOWANCE,
      lastResetDate: today,
      mathChallengesCompletedToday: 0,
      gamesPlayed: 0,
      biggestWin: 0,
    }).returning();
    player = newPlayer;
  }

  res.json(GetPlayerResponse.parse({
    id: String(player.id),
    username: player.username,
    credits: player.credits,
    points: player.points,
    dailyCreditsRemaining: player.dailyCreditsRemaining,
    lastResetDate: player.lastResetDate,
    mathChallengesCompletedToday: player.mathChallengesCompletedToday,
  }));
});

router.post("/player/daily-reset", async (req, res): Promise<void> => {
  let sessionId = req.cookies?.["casino_session"];

  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    res.cookie("casino_session", sessionId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    });
  }

  const today = getTodayDate();
  let [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));

  if (!player) {
    const [newPlayer] = await db.insert(playersTable).values({
      sessionId,
      username: getRandomUsername(),
      credits: DAILY_CREDIT_ALLOWANCE,
      points: 0,
      dailyCreditsRemaining: DAILY_CREDIT_ALLOWANCE,
      lastResetDate: today,
      mathChallengesCompletedToday: 0,
      gamesPlayed: 0,
      biggestWin: 0,
    }).returning();
    player = newPlayer;
  }

  if (player.lastResetDate !== today) {
    const [updated] = await db.update(playersTable)
      .set({
        dailyCreditsRemaining: DAILY_CREDIT_ALLOWANCE,
        lastResetDate: today,
        mathChallengesCompletedToday: 0,
      })
      .where(eq(playersTable.sessionId, sessionId))
      .returning();
    player = updated;
  }

  res.json(DailyResetResponse.parse({
    id: String(player.id),
    username: player.username,
    credits: player.credits,
    points: player.points,
    dailyCreditsRemaining: player.dailyCreditsRemaining,
    lastResetDate: player.lastResetDate,
    mathChallengesCompletedToday: player.mathChallengesCompletedToday,
  }));
});

router.patch("/player/username", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const parsed = UpdateUsernameBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username } = parsed.data;
  const trimmed = username.trim();

  if (!trimmed || trimmed.length < 2 || trimmed.length > 20) {
    res.status(400).json({ error: "Name muss 2-20 Zeichen lang sein." });
    return;
  }

  const [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  const [updated] = await db.update(playersTable)
    .set({ username: trimmed })
    .where(eq(playersTable.sessionId, sessionId))
    .returning();

  res.json(UpdateUsernameResponse.parse({
    id: String(updated.id),
    username: updated.username,
    credits: updated.credits,
    points: updated.points,
    dailyCreditsRemaining: updated.dailyCreditsRemaining,
    lastResetDate: updated.lastResetDate,
    mathChallengesCompletedToday: updated.mathChallengesCompletedToday,
  }));
});

/** POST /player/transfer { toUsername, amount } — Credits an anderen Spieler senden */
router.post("/player/transfer", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const { toUsername, amount } = req.body ?? {};
  if (!toUsername || typeof toUsername !== "string") {
    res.status(400).json({ error: "Empfänger-Benutzername erforderlich." });
    return;
  }
  const amt = parseInt(amount);
  if (isNaN(amt) || amt <= 0) {
    res.status(400).json({ error: "Ungültiger Betrag." });
    return;
  }

  const [sender] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  if (!sender) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }
  if (sender.credits < amt) {
    res.status(400).json({ error: "Nicht genug Credits." });
    return;
  }

  // Find recipient by username (must be different player)
  const allWithName = await db.select().from(playersTable).where(eq(playersTable.username, toUsername.trim()));
  const recipient = allWithName.find(p => p.id !== sender.id);
  if (!recipient) {
    res.status(404).json({ error: `Spieler "${toUsername}" nicht gefunden.` });
    return;
  }

  const newSenderCredits = sender.credits - amt;
  const newRecipientCredits = recipient.credits + amt;

  await db.update(playersTable).set({ credits: newSenderCredits }).where(eq(playersTable.id, sender.id));
  await db.update(playersTable).set({ credits: newRecipientCredits }).where(eq(playersTable.id, recipient.id));

  res.json({
    success: true,
    newCredits: newSenderCredits,
    message: `${amt} Credits wurden an ${recipient.username} gesendet.`,
  });
});

export default router;
