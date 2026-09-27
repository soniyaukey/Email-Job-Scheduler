import { randomUUID } from 'node:crypto'
import { DelayedError, Worker } from 'bullmq'
import nodemailer from 'nodemailer'
import { config, type SenderConfig } from './config.js'
import { db } from './db.js'
import { queueConnection, type EmailJobData } from './queue.js'

const reserveSenderSlot = `
  local count = tonumber(redis.call('GET', KEYS[1]) or '0')
  local limit = tonumber(ARGV[1])
  if count >= limit then return 0 end
  count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
  return 1
`
const renewSendLock = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
  end
  return 0
`
const releaseSendLock = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`
const sendLockTtlSeconds = 120

interface EmailRow {
  id: string
  recipient: string
  subject: string
  body: string
  sender_email: string
  hourly_limit: number
  user_sub: string
}

export function startEmailWorker(senders: SenderConfig[]) {
  const transporters = new Map(senders.map((sender) => [sender.email, nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: { user: sender.user, pass: sender.pass },
  })]))

  const worker = new Worker<EmailJobData>('scheduled-emails', async (job, token) => {
    const lookup = await db.query<EmailRow>(`
      SELECT id, recipient, subject, body, sender_email, hourly_limit, user_sub
      FROM emails WHERE id = $1 AND status = 'scheduled'
    `, [job.data.emailId])
    const email = lookup.rows[0]
    if (!email) return

    const now = Date.now()
    const hourWindow = Math.floor(now / 3_600_000)
    const secondsToWindowEnd = Math.ceil(((hourWindow + 1) * 3_600_000 - now) / 1000)
    const allowed = await queueConnection.eval(
      reserveSenderSlot,
      1,
      `email-hour:${email.sender_email}:${hourWindow}`,
      email.hourly_limit,
      secondsToWindowEnd + 3600,
    )
    if (Number(allowed) !== 1) {
      if (!token) throw new Error('BullMQ lock token is unavailable for rescheduling')
      await job.moveToDelayed((hourWindow + 1) * 3_600_000, token)
      throw new DelayedError()
    }

    const lockKey = `scheduler:send-lock:${email.id}`
    const lockToken = randomUUID()
    const locked = await queueConnection.set(lockKey, lockToken, 'EX', sendLockTtlSeconds, 'NX')
    if (locked !== 'OK') {
      if (!token) throw new Error('BullMQ lock token is unavailable for rescheduling')
      await job.moveToDelayed(Date.now() + 5000, token)
      throw new DelayedError()
    }

    const claimed = await db.query<EmailRow>(`
      UPDATE emails SET status = 'sending', updated_at = NOW()
      WHERE id = $1 AND status = 'scheduled'
      RETURNING id, recipient, subject, body, sender_email, hourly_limit, user_sub
    `, [email.id])
    const claimedEmail = claimed.rows[0]
    if (!claimedEmail) {
      await queueConnection.eval(releaseSendLock, 1, lockKey, lockToken)
      return
    }

    const lockRenewal = setInterval(() => {
      void queueConnection.eval(renewSendLock, 1, lockKey, lockToken, sendLockTtlSeconds)
        .catch((error: unknown) => console.error(`Could not renew send lease for ${email.id}:`, error))
    }, 30_000)
    try {
      const transporter = transporters.get(claimedEmail.sender_email)
      if (!transporter) throw new Error(`No SMTP transport configured for ${claimedEmail.sender_email}`)
      const sender = senders.find((entry) => entry.email === claimedEmail.sender_email)
      const info = await transporter.sendMail({
        from: sender?.name ? { name: sender.name, address: sender.email } : sender?.email,
        to: claimedEmail.recipient,
        subject: claimedEmail.subject,
        text: claimedEmail.body,
      })
      await db.query(`
        UPDATE emails SET status = 'sent', sent_at = NOW(), updated_at = NOW(), error = NULL
        WHERE id = $1 AND status = 'sending'
      `, [claimedEmail.id])
      const preview = nodemailer.getTestMessageUrl(info)
      if (preview) console.info(`Ethereal preview for ${claimedEmail.id}: ${preview}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SMTP delivery failed'
      await db.query(`
        UPDATE emails SET status = 'failed', error = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'sending'
      `, [claimedEmail.id, message.slice(0, 2000)])
    } finally {
      clearInterval(lockRenewal)
      await queueConnection.eval(releaseSendLock, 1, lockKey, lockToken)
    }
  }, {
    connection: queueConnection.duplicate({ maxRetriesPerRequest: null }),
    concurrency: config.WORKER_CONCURRENCY,
    limiter: config.MIN_SEND_DELAY_MS > 0
      ? { max: 1, duration: config.MIN_SEND_DELAY_MS }
      : undefined,
  })

  worker.on('failed', (job, error) => {
    console.error(`Queue job ${job?.id ?? 'unknown'} failed:`, error.message)
  })
  return worker
}