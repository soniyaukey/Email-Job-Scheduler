import pg from 'pg'
import { config } from './config.js'

const { Pool } = pg
export const db = new Pool({ connectionString: config.DATABASE_URL })

export async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_sub TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS emails (
      id UUID PRIMARY KEY,
      user_sub TEXT NOT NULL REFERENCES users(google_sub),
      idempotency_key UUID NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      send_delay_ms INTEGER NOT NULL,
      hourly_limit INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'sending', 'sent', 'failed')),
      sent_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_sub, idempotency_key, recipient)
    );
    CREATE INDEX IF NOT EXISTS emails_user_status_schedule_idx
      ON emails(user_sub, status, scheduled_at);
    CREATE INDEX IF NOT EXISTS emails_recovery_idx
      ON emails(status, scheduled_at) WHERE status = 'scheduled';
  `)
}