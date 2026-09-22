import { z } from "zod";
import { locations } from "./relations.mjs";
import { events } from "./store.mjs";
import { createPlanSchema, patchPlanSchema, fail } from "./plan-domain.mjs";
import { createPlan, patchPlan, listPlans, getPlan } from "./plan-store.mjs";
const querySchema = z.object({
  recordPurpose: z.enum(["inspection", "presentation", "verification", "all"]).default("inspection"),
  visibility: z.enum(["visible", "hidden", "all"]).default("visible"),
  teamId: z.enum(["all", ...locations.teams.map((team) => team.id)]).default("all"),
  rackId: z.enum(["all", ...locations.racks.map((rack) => rack.id)]).default("all"),
}).strict();
export function registerPlanRoutes(app) {
  app.get("/api/plans", async (req, res) => res.json(await listPlans(querySchema.parse(req.query))));
  app.get("/api/plans/:id/history", async (req, res) => res.json(await events(z.string().uuid().parse(req.params.id))));
  app.get("/api/plans/:id", async (req, res) => {
    const plan = await getPlan(z.string().uuid().parse(req.params.id));
    if (!plan) throw fail(404, "검사계획을 찾을 수 없습니다.");
    res.json(plan);
  });
  app.post("/api/plans", async (req, res) => res.status(201).json(await createPlan(createPlanSchema.parse(req.body))));
  app.patch("/api/plans/:id", async (req, res) => res.json(await patchPlan(z.string().uuid().parse(req.params.id), patchPlanSchema.parse(req.body))));
}
