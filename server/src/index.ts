import cors from 'cors'
import express from 'express'
import cookieParser from 'cookie-parser'
import nodemailer from 'nodemailer'
import { authRouter, requireAuth } from './auth.js'
import { config, getConfiguredSenders, type SenderConfig } from './config.js'
import { db, initializeDatabase } from './db.js'
import { emailRouter } from './emails.js'
import { emailQueue, enqueueEmail, queueConnection } from './queue.js'
import { startEmailWorker } from './worker.js'

async function resolveSenders(): Promise<SenderConfig[]> {
  const configured = getConfiguredSenders()
  if (configured.length) return configured
  const key = 'scheduler:ethereal-sender:v1'
  const stored = await queueConnection.get(key)
  if (stored) return [JSON.parse(stored) as SenderConfig]
  const account = await nodemailer.createTestAccount()
  const sender: SenderConfig = {
    email: account.user,
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    user: account.user,
    pass: account.pass,
    name: 'ReachInbox Scheduler',
  }
  await queueConnection.set(key, JSON.stringify(sender), 'NX')
  const persisted = await queueConnection.get(key)
  if (!persisted) throw new Error('Could not persist the Ethereal sender in Redis')
  const resolved = JSON.parse(persisted) as SenderConfig
  console.info(`Using persistent Ethereal test sender ${resolved.email}`)
  return [resolved]
}

async function recoverScheduledEmails() {
  const inFlight = await db.query<{ id: string }>(`SELECT id FROM emails WHERE status = 'sending'`)
  for (const email of inFlight.rows) {
    const lockExists = await queueConnection.exists(`scheduler:send-lock:${email.id}`)
    if (lockExists === 0) {
      await db.query(`
        UPDATE emails SET status = 'failed',
          error = 'Delivery outcome was unknown after a restart; not retried to prevent duplicates.',
          updated_at = NOW()
        WHERE id = $1 AND status = 'sending'
      `, [email.id])
    }
  }
  const pending = await db.query<{ id: string; scheduled_at: Date }>(`
    SELECT id, scheduled_at FROM emails WHERE status = 'scheduled'
    ORDER BY scheduled_at ASC
  `)
  for (const email of pending.rows) {
    await enqueueEmail(email.id, new Date(email.scheduled_at))
  }
  console.info(`Recovered ${pending.rowCount ?? 0} scheduled email jobs`)
}

async function main() {
  await initializeDatabase()
  await queueConnection.ping()
  const senders = await resolveSenders()
  await recoverScheduledEmails()

  const app = express()
  app.locals.senders = senders
  app.use(cors({ origin: config.FRONTEND_URL, credentials: true }))
  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.use('/api/auth', authRouter)
  app.use('/api/emails', requireAuth, emailRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('API request failed:', error)
    if (res.headersSent) return _next(error)
    res.status(500).json({ error: 'The request could not be completed.' })
  })

  const worker = startEmailWorker(senders)
  const server = app.listen(config.PORT, () => {
    console.info(`Scheduler API listening on http://localhost:${config.PORT}`)
    if (!config.GOOGLE_CLIENT_ID) console.warn('Google OAuth is not configured; sign-in is disabled.')
  })

  const shutdown = async () => {
    server.close()
    await worker.close()
    await emailQueue.close()
    await queueConnection.quit()
    await db.end()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('Scheduler startup failed:', error)
  process.exit(1)
})