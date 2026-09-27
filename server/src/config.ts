import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().default('postgres://reachinbox:reachinbox@localhost:5432/reachinbox'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(24).default('local-development-secret-change-before-deploy'),
  SMTP_SENDERS_JSON: z.string().default(''),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  MIN_SEND_DELAY_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

const parsedEnv = envSchema.parse(process.env)
export const config = {
  ...parsedEnv,
  GOOGLE_CALLBACK_URL: parsedEnv.GOOGLE_CALLBACK_URL
    ?? `${process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000'}/api/auth/google/callback`,
}

export interface SenderConfig {
  email: string
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  name?: string
}

export function getConfiguredSenders(): SenderConfig[] {
  if (!config.SMTP_SENDERS_JSON) return []
  const schema = z.array(z.object({
    email: z.string().email(),
    host: z.string().min(1),
    port: z.number().int().positive(),
    secure: z.boolean().default(false),
    user: z.string().min(1),
    pass: z.string().min(1),
    name: z.string().optional(),
  })).min(1)
  return schema.parse(JSON.parse(config.SMTP_SENDERS_JSON))
}