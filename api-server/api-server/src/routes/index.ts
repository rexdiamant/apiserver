import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playerRouter from "./player";
import gamblingRouter from "./gambling";
import scoreboardRouter from "./scoreboard";
import mathRouter from "./math";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(authRouter);
router.use(playerRouter);
router.use(gamblingRouter);
router.use(scoreboardRouter);
router.use(mathRouter);
router.use(healthRouter);

export default router;
