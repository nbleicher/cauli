import { z } from "zod";
import {
  CALL_STATUSES,
  REVIEW_STATUSES,
  ROLES,
  SOURCE_MODES,
} from "./types.js";

export const roleSchema = z.enum(ROLES);
export const sourceModeSchema = z.enum(SOURCE_MODES);
export const callStatusSchema = z.enum(CALL_STATUSES);
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);

export const createCallSchema = z.object({
  sourceMode: sourceModeSchema,
  micLabel: z.string().trim().max(256).optional(),
  tabLabel: z.string().trim().max(256).optional(),
});

export const finalizeCallSchema = z.object({
  finalChunkSequence: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  mimeType: z.string().trim().min(1).max(128),
  sourceMode: sourceModeSchema,
  micLabel: z.string().trim().max(256).optional(),
  tabLabel: z.string().trim().max(256).optional(),
  degradedIntervals: z
    .array(
      z
        .object({
          source: z.enum(["mic", "tab"]),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().nonnegative().nullable(),
        })
        .refine(
          (interval) =>
            interval.endMs === null || interval.endMs >= interval.startMs,
          { message: "A degraded interval cannot end before it starts." }
        )
    )
    .max(2),
});

export const reviewAnswerSchema = z.object({
  criterionId: z.uuid(),
  value: z.number().int().min(1).max(5).nullable(),
  comment: z.string().trim().max(4_000).default(""),
});

export const submitReviewSchema = z.object({
  expectedVersion: z.number().int().min(0),
  status: reviewStatusSchema.exclude(["unreviewed"]),
  summary: z.string().trim().max(10_000).default(""),
  followUp: z.string().trim().max(10_000).default(""),
  answers: z.array(reviewAnswerSchema),
});

export const extensionRecordingSchema = z.object({
  legacyRecordingId: z.union([z.string(), z.number()]).transform(String),
  date: z.iso.datetime(),
  duration: z.number().nonnegative(),
  source: sourceModeSchema,
  transcript: z.string().default(""),
  transcriptStatus: z.string().max(32).default("none"),
  sourceMimeType: z.string().max(128).default(""),
  convertedMimeType: z.string().max(128).default(""),
  hasSource: z.boolean(),
  hasConverted: z.boolean(),
});

export const prepareExtensionImportSchema = z.object({
  nonce: z.string().min(16).max(256),
  recordings: z.array(extensionRecordingSchema).max(2_000),
});

export const completeExtensionImportSchema = z.object({
  nonce: z.string().min(16).max(256),
  items: z
    .array(
      z.object({
        importId: z.uuid(),
        sourceUploaded: z.boolean(),
        convertedUploaded: z.boolean(),
      })
    )
    .max(2_000),
});

export const createScorecardTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        criteria: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(240),
              description: z.string().trim().max(1_000).default(""),
              weight: z.number().int().positive().max(10_000),
              required: z.boolean().default(true),
            })
          )
          .min(1)
          .max(100),
      })
    )
    .min(1)
    .max(30),
});
