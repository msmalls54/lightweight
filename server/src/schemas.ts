import { z } from "zod";

const sample = z.number().finite().min(0).max(16383);
export const batchSchema = z.object({
  device: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  t0_ms: z.number().finite().min(0),
  dt_ms: z.number().finite().positive().max(1000),
  ch: z.array(z.array(sample).min(1).max(2000)).length(4),
}).refine(b => b.ch.every(c => c.length === b.ch[0].length), { message: "ch arrays must be equal length", path: ["ch"] });

export const heartbeatSchema = z.object({
  device: z.string().min(1).max(64),
  seq: z.number().int().min(0).optional(),
  uptime_ms: z.number().finite().min(0).optional(),
  rssi: z.number().finite().optional(),
  queue: z.number().int().min(0).optional(),
  fw: z.string().max(32).optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const armsSchema = z.array(z.enum(["R", "L"])).min(1).max(2);
export const variantSchema = z.enum(["standing", "preacher", "hammer"]);

export const sessionStartSchema = z.object({
  person: z.string().trim().min(1).max(60).default("Mike"),
  walkup: z.boolean().default(false),
  arms: armsSchema.optional(),
  kind: z.enum(["live", "fake"]).default("live"),
});

export const setStartSchema = z.object({
  exercise: z.string().trim().min(1).max(60).default("dumbbell curl"),
  variant: variantSchema.default("standing"),
  load_lb: z.number().finite().min(0).max(500).optional(),
  arms: armsSchema.optional(),
  auto_next: z.boolean().default(true),
});

export const captureSchema = z.object({
  step: z.enum(["rest", "mvc"]),
  ch: z.number().int().min(0).max(3).optional(),
  window_ms: z.number().int().min(500).max(5000).default(2500),
}).refine(c => c.step === "rest" || c.ch !== undefined, { message: "mvc capture needs ch", path: ["ch"] });
