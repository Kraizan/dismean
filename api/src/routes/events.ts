/** Server-sent events stream. See docs/code-map.md · LLD §10. */
import { Router } from "express";
import { z } from "zod";
import { getEvents } from "../events.js";

const querySchema = z.object({
  after_id: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export function eventsRouter(): Router {
  const router = Router();

  router.get("/events", (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid query" });
      return;
    }
    const { after_id, limit } = parsed.data;
    res.json({ events: getEvents(after_id, limit) });
  });

  return router;
}
