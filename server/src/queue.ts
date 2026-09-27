import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

export const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

export interface EmailJobData {
  emailId: string
}

export const emailQueue = new Queue<EmailJobData>('scheduled-emails', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: { age: 604800, count: 10000 },
  },
})

export async function enqueueEmail(emailId: string, scheduledAt: Date) {
  await emailQueue.add('send-email', { emailId }, {
    jobId: `email-${emailId}`,
    delay: Math.max(0, scheduledAt.getTime() - Date.now()),
  })
}