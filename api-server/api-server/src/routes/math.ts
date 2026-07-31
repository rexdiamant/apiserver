import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, playersTable, mathSolvesTable } from "@workspace/db";
import {
  GetDailyMathChallengesResponse,
  SubmitMathAnswerBody,
  SubmitMathAnswerResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

type Challenge = {
  id: number;
  question: string;
  answer: number;
  creditReward: number;
};

function getDailyChallenges(dateStr: string): Challenge[] {
  const seed = dateStr.split("-").reduce((acc, n) => acc + parseInt(n), 0);
  const rng = (n: number) => ((seed * 9301 + 49297 * (n + 1)) % 233280) / 233280;

  const challenges: Challenge[] = [
    {
      id: 1,
      question: "",
      answer: 0,
      creditReward: 50,
    },
    {
      id: 2,
      question: "",
      answer: 0,
      creditReward: 75,
    },
    {
      id: 3,
      question: "",
      answer: 0,
      creditReward: 100,
    },
    {
      id: 4,
      question: "",
      answer: 0,
      creditReward: 150,
    },
  ];

  const a1 = Math.floor(rng(0) * 50) + 10;
  const b1 = Math.floor(rng(1) * 50) + 10;
  challenges[0].question = `${a1} + ${b1} = ?`;
  challenges[0].answer = a1 + b1;

  const a2 = Math.floor(rng(2) * 20) + 5;
  const b2 = Math.floor(rng(3) * 10) + 2;
  challenges[1].question = `${a2} x ${b2} = ?`;
  challenges[1].answer = a2 * b2;

  const a3 = Math.floor(rng(4) * 30) + 20;
  const b3 = Math.floor(rng(5) * 15) + 5;
  const c3 = Math.floor(rng(6) * 10) + 1;
  challenges[2].question = `${a3} + ${b3} - ${c3} = ?`;
  challenges[2].answer = a3 + b3 - c3;

  const a4 = Math.floor(rng(7) * 10) + 2;
  const b4 = Math.floor(rng(8) * 10) + 2;
  const c4 = Math.floor(rng(9) * 5) + 1;
  challenges[3].question = `(${a4} x ${b4}) + ${c4} = ?`;
  challenges[3].answer = a4 * b4 + c4;

  return challenges;
}

router.get("/math/daily", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  const today = getTodayDate();
  const challenges = getDailyChallenges(today);

  let solvedIds: number[] = [];
  if (sessionId) {
    const solves = await db.select().from(mathSolvesTable)
      .where(and(
        eq(mathSolvesTable.sessionId, sessionId),
        eq(mathSolvesTable.solvedDate, today)
      ));
    solvedIds = solves.map(s => s.challengeId);
  }

  const [player] = sessionId ? await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId)) : [null];

  res.json(GetDailyMathChallengesResponse.parse({
    challenges: challenges.map(c => ({
      id: c.id,
      question: c.question,
      creditReward: c.creditReward,
      solved: solvedIds.includes(c.id),
    })),
    completedToday: player?.mathChallengesCompletedToday ?? 0,
  }));
});

router.post("/math/answer", async (req, res): Promise<void> => {
  const sessionId = req.cookies?.["casino_session"];
  if (!sessionId) {
    res.status(400).json({ error: "No session found." });
    return;
  }

  const parsed = SubmitMathAnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { challengeId, answer } = parsed.data;
  const today = getTodayDate();
  const challenges = getDailyChallenges(today);
  const challenge = challenges.find(c => c.id === challengeId);

  if (!challenge) {
    res.status(400).json({ error: "Challenge not found." });
    return;
  }

  const [existingSolve] = await db.select().from(mathSolvesTable)
    .where(and(
      eq(mathSolvesTable.sessionId, sessionId),
      eq(mathSolvesTable.challengeId, challengeId),
      eq(mathSolvesTable.solvedDate, today)
    ));

  if (existingSolve) {
    res.status(400).json({ error: "Challenge already completed today." });
    return;
  }

  const [player] = await db.select().from(playersTable).where(eq(playersTable.sessionId, sessionId));
  if (!player) {
    res.status(400).json({ error: "Player not found." });
    return;
  }

  const correct = Math.abs(answer - challenge.answer) < 0.001;
  let creditsAwarded = 0;
  let newCredits = player.credits;

  if (correct) {
    creditsAwarded = challenge.creditReward;
    newCredits = player.credits + creditsAwarded;
    const newDailyRemaining = player.dailyCreditsRemaining + creditsAwarded;

    await db.insert(mathSolvesTable).values({
      sessionId,
      challengeId,
      solvedDate: today,
      creditsAwarded,
    });

    await db.update(playersTable).set({
      credits: newCredits,
      dailyCreditsRemaining: newDailyRemaining,
      mathChallengesCompletedToday: player.mathChallengesCompletedToday + 1,
    }).where(eq(playersTable.sessionId, sessionId));
  }

  res.json(SubmitMathAnswerResponse.parse({
    correct,
    creditsAwarded,
    newCredits,
    message: correct
      ? `Correct! You earned ${creditsAwarded} credits!`
      : `Wrong answer. The correct answer was ${challenge.answer}.`,
  }));
});

export default router;
