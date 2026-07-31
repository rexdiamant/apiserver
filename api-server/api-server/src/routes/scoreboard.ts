import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { GetScoreboardResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/scoreboard", async (_req, res): Promise<void> => {
  const players = await db.select().from(playersTable).orderBy(desc(playersTable.points)).limit(20);

  const entries = players.map((p, i) => ({
    rank: i + 1,
    username: p.username,
    points: p.points,
    gamesPlayed: p.gamesPlayed,
    biggestWin: p.biggestWin,
  }));

  res.json(GetScoreboardResponse.parse(entries));
});

export default router;
