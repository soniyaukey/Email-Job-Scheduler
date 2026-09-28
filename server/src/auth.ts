import { randomBytes } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import { OAuth2Client } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { db } from './db.js'

export interface SessionUser {
  googleSub: string
  email: string
  name: string
  picture: string
}

const oauthClient = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_CALLBACK_URL,
)
const cookieOptions = {
  httpOnly: true,
  sameSite: config.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
  secure: config.NODE_ENV === 'production',
  path: '/',
}

export const authRouter = Router()

authRouter.get('/google', (req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' })
    return
  }
  const state = randomBytes(24).toString('hex')
  res.cookie('oauth_state', state, { ...cookieOptions, maxAge: 10 * 60 * 1000 })
  res.redirect(oauthClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
  }))
})

authRouter.get('/google/callback', async (req, res, next) => {
  try {
    const stateCookie = req.cookies?.oauth_state as string | undefined
    res.clearCookie('oauth_state', cookieOptions)
    if (!stateCookie || req.query.state !== stateCookie || typeof req.query.code !== 'string') {
      res.status(400).send('Google sign-in could not be verified. Please try again.')
      return
    }
    const { tokens } = await oauthClient.getToken(req.query.code)
    if (!tokens.id_token) throw new Error('Google did not return an identity token')
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.GOOGLE_CLIENT_ID,
    })
    const profile = ticket.getPayload()
    if (!profile?.sub || !profile.email || !profile.email_verified) {
      res.status(401).send('A verified Google account is required.')
      return
    }
    const user: SessionUser = {
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name ?? profile.email,
      picture: profile.picture ?? '',
    }
    await db.query(`
      INSERT INTO users (google_sub, email, name, picture)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email,
        name = EXCLUDED.name, picture = EXCLUDED.picture
    `, [user.googleSub, user.email, user.name, user.picture])
    const token = jwt.sign({ email: user.email, name: user.name, picture: user.picture }, config.SESSION_SECRET, {
      subject: user.googleSub,
      expiresIn: 7 * 24 * 60 * 60,
    })
    res.cookie('session', token, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 })
    res.redirect(config.FRONTEND_URL)
  } catch (error) {
    next(error)
  }
})

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = req.cookies?.session as string | undefined
  if (!token) {
    res.status(401).json({ error: 'Sign in with Google to continue.' })
    return
  }
  try {
    const decoded = jwt.verify(token, config.SESSION_SECRET)
    if (typeof decoded === 'string' || !decoded.sub || typeof decoded.email !== 'string') {
      throw new Error('Invalid session')
    }
    res.locals.user = {
      googleSub: decoded.sub,
      email: decoded.email,
      name: typeof decoded.name === 'string' ? decoded.name : decoded.email,
      picture: typeof decoded.picture === 'string' ? decoded.picture : '',
    } satisfies SessionUser
    next()
  } catch {
    res.clearCookie('session', cookieOptions)
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }
}

authRouter.get('/me', requireAuth, (_req, res) => {
  const user = res.locals.user as SessionUser
  res.json({ user: { email: user.email, name: user.name, picture: user.picture } })
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('session', cookieOptions)
  res.status(204).end()
})