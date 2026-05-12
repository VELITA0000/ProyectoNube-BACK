import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV);

if (!isLambda) {
  loadDotenv({ path: resolve(process.cwd(), ".env") });
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required (Postgres connection string, e.g. Neon)"),
    AWS_REGION: z.string().min(1),
    AWS_ACCESS_KEY_ID: z.string().optional().default(""),
    AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
    AWS_SESSION_TOKEN: z.string().optional().default(""),
    COGNITO_USER_POOL_ID: z.string().min(1),
    COGNITO_CLIENT_ID: z.string().min(1),
    S3_BUCKET_ORIGINALS: z.string().min(1),
    SQS_WATERMARK_QUEUE_URL: z.string().url(),
    FRONTEND_ORIGIN: z.string().url(),
    STRIPE_SECRET_KEY: z.string().default(""),
    STRIPE_WEBHOOK_SECRET: z.string().default(""),
    SNS_TRANSACTIONS_TOPIC_ARN: z.string().default(""),
    DEFAULT_PHOTO_UNIT_PRICE_USD: z.coerce.number().positive(),
  })
  .superRefine((data, ctx) => {
    const anySet = Boolean(data.AWS_ACCESS_KEY_ID || data.AWS_SECRET_ACCESS_KEY || data.AWS_SESSION_TOKEN);
    const allSet = Boolean(data.AWS_ACCESS_KEY_ID && data.AWS_SECRET_ACCESS_KEY && data.AWS_SESSION_TOKEN);
    if (anySet && !allSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AWS credentials: set all three together or leave all empty (on Lambda leave empty and use LabRole).",
        path: ["AWS_ACCESS_KEY_ID"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment variables: ${JSON.stringify(msg)}`);
  }
  cached = parsed.data;
  return parsed.data;
}
