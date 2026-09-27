import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { config } from './config.js'
import { db } from './db.js'
import { enqueueEmail } from './queue.js'
import type { SessionUser } from './auth.js'

export const emailRouter = Router()

const scheduleSchema = z.object({
  idempotencyKey: z.string().uuid(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(50000),
  recipients: z.array(z.string().trim().email().transform((email) => email.toLowerCase())).min(1).max(5000),
  startsAt: z.iso.datetime({ offset: true }),
  sendDelayMs: z.number().int().min(config.MIN_SEND_DELAY_MS).max(86400000),
  hourlyLimit: z.number().int().min(1),
})

emailRouter.post('/', async (req, res, next) => {
  const parsed = scheduleSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid schedule request.', details: parsed.error.flatten() })
    return
  }
  const input = parsed.data
  if (input.hourlyLimit > config.MAX_EMAILS_PER_HOUR_PER_SENDER) {
    res.status(400).json({
      error: `Hourly limit cannot exceed the configured sender maximum of ${config.MAX_EMAILS_PER_HOUR_PER_SENDER}.`,
    })
    return
  }
  const recipients = [...new Set(input.recipients)]
  const startsAt = new Date(input.startsAt)
  if (startsAt.getTime() < Date.now() - 10_000) {
    res.status(400).json({ error: 'Start time must be in the future.' })
    return
  }
  const senders = res.app.locals.senders as Array<{ email: string }>
  const user = res.locals.user as SessionUser
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const created: Array<{ id: string; scheduled_at: Date }> = []
    for (const [index, recipient] of recipients.entries()) {
      const id = randomUUID()
      const sender = senders[index % senders.length].email
      const scheduledAt = new Date(startsAt.getTime() + index * input.sendDelayMs)
      const result = await client.query<{ id: string; scheduled_at: Date }>(`
        INSERT INTO emails (id, user_sub, idempotency_key, recipient, subject, body,
          sender_email, scheduled_at, send_delay_ms, hourly_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (user_sub, idempotency_key, recipient) DO NOTHING
        RETURNING id, scheduled_at
      `, [id, user.googleSub, input.idempotencyKey, recipient, input.subject, input.body,
        sender, scheduledAt, input.sendDelayMs, input.hourlyLimit])
      if (result.rows[0]) created.push(result.rows[0])
    }
    await client.query('COMMIT')

    const existing = await db.query<{ id: string; scheduled_at: Date; status: string }>(`
      SELECT id, scheduled_at, status FROM emails
      WHERE user_sub = $1 AND idempotency_key = $2 AND recipient = ANY($3::text[])
    `, [user.googleSub, input.idempotencyKey, recipients])
    await Promise.all(existing.rows
      .filter((email) => email.status === 'scheduled')
      .map((email) => enqueueEmail(email.id, new Date(email.scheduled_at))))

    res.status(202).json({
      scheduled: existing.rows.filter((email) => email.status === 'scheduled').length,
      accepted: recipients.length,
      created: created.length,
      idempotencyKey: input.idempotencyKey,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    next(error)
  } finally {
    client.release()
  }
})

emailRouter.get('/config', (_req, res) => {
  res.json({
    maxEmailsPerHourPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    minSendDelayMs: config.MIN_SEND_DELAY_MS,
  })
})

emailRouter.get('/', async (req, res, next) => {
  const status = req.query.status
  if (status !== 'scheduled' && status !== 'sent') {
    res.status(400).json({ error: 'status must be scheduled or sent.' })
    return
  }
  try {
    const user = res.locals.user as SessionUser
    const result = status === 'scheduled'
      ? await db.query(`
          SELECT id, recipient, subject, scheduled_at, status, sender_email, error
          FROM emails WHERE user_sub = $1 AND status IN ('scheduled', 'sending')
          ORDER BY scheduled_at ASC LIMIT 500
        `, [user.googleSub])
      : await db.query(`
          SELECT id, recipient, subject, sent_at, status, sender_email, error
          FROM emails WHERE user_sub = $1 AND status IN ('sent', 'failed')
          ORDER BY COALESCE(sent_at, updated_at) DESC LIMIT 500
        `, [user.googleSub])
    res.json({ emails: result.rows })
  } catch (error) {
    next(error)
  }
})