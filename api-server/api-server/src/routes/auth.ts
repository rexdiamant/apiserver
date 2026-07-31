import { Router, type IRouter } from "express";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, playersTable, accountsTable } from "@workspace/db";

const router: IRouter = Router();

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateSessionId(): string {
  return `session_${Date.now()}_${crypto.randomBytes(12).toString("hex")}`;
}

const DAILY_CREDIT_ALLOWANCE = 500;

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/** GET /auth/status — ist die aktuelle Session eingeloggt? */
router.get("/auth/status", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.json({ loggedIn: false, loginName: null });
    return;
  }
  const [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  if (!player) {
    res.json({ loggedIn: false, loginName: null });
    return;
  }
  // Check if this player has an account linked
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.playerId, String(player.id)));
  res.json({ loggedIn: !!account, loginName: account?.loginName ?? null });
});

/** POST /auth/register { loginName, password } */
router.post("/auth/register", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "Keine Session gefunden." });
    return;
  }

  const { loginName, password } = req.body ?? {};
  if (!loginName || typeof loginName !== "string" || loginName.trim().length < 3 || loginName.trim().length > 20) {
    res.status(400).json({ error: "Benutzername muss 3–20 Zeichen lang sein." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "Passwort muss mindestens 6 Zeichen lang sein." });
    return;
  }

  const trimmedName = loginName.trim();
  const [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  if (!player) {
    res.status(400).json({ error: "Spieler nicht gefunden." });
    return;
  }

  // Check if already has account
  const [existingAccount] = await db.select().from(accountsTable).where(eq(accountsTable.playerId, String(player.id)));
  if (existingAccount) {
    res.status(400).json({ error: "Du hast bereits ein Konto registriert." });
    return;
  }

  // Check if loginName already taken
  const [taken] = await db.select().from(accountsTable).where(eq(accountsTable.loginName, trimmedName));
  if (taken) {
    res.status(400).json({ error: "Dieser Anmeldename ist bereits vergeben." });
    return;
  }

  const salt = generateSalt();
  const passHash = hashPassword(password, salt);

  await db.insert(accountsTable).values({
    loginName: trimmedName,
    passHash,
    passSalt: salt,
    playerId: String(player.id),
  });

  res.json({ success: true, loginName: trimmedName });
});

/** POST /auth/login { loginName, password } */
router.post("/auth/login", async (req, res): Promise<void> => {
  const { loginName, password } = req.body ?? {};
  if (!loginName || !password) {
    res.status(400).json({ error: "Anmeldename und Passwort erforderlich." });
    return;
  }

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.loginName, loginName.trim()));
  if (!account) {
    res.status(401).json({ error: "Ungültige Anmeldedaten." });
    return;
  }

  const hash = hashPassword(password, account.passSalt);
  if (hash !== account.passHash) {
    res.status(401).json({ error: "Ungültige Anmeldedaten." });
    return;
  }

  // Find the player linked to this account
  const [targetPlayer] = await db.select().from(playersTable).where(eq(playersTable.id, parseInt(account.playerId)));
  if (!targetPlayer) {
    res.status(500).json({ error: "Spielerdaten nicht gefunden." });
    return;
  }

  // Assign new session id to this player so the current device is linked
  const newSession = generateSessionId();
  await db.update(playersTable).set({ sessionId: newSession }).where(eq(playersTable.id, targetPlayer.id));

  res.cookie("casino_session", newSession, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  });

  res.json({
    success: true,
    loginName: account.loginName,
    player: {
      id: String(targetPlayer.id),
      username: targetPlayer.username,
      credits: targetPlayer.credits,
      points: targetPlayer.points,
      dailyCreditsRemaining: targetPlayer.dailyCreditsRemaining,
    },
  });
});

/** POST /auth/logout */
router.post("/auth/logout", async (req, res): Promise<void> => {
  // Give the device a fresh anonymous session
  const newSession = generateSessionId();
  const today = getTodayDate();
  await db.insert(playersTable).values({
    sessionId: newSession,
    username: "Gast" + Math.floor(Math.random() * 9999),
    credits: DAILY_CREDIT_ALLOWANCE,
    points: 0,
    dailyCreditsRemaining: DAILY_CREDIT_ALLOWANCE,
    lastResetDate: today,
    mathChallengesCompletedToday: 0,
    gamesPlayed: 0,
    biggestWin: 0,
  });

  res.cookie("casino_session", newSession, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  });

  res.json({ success: true });
});

export default router;
