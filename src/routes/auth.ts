import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'

function serializeUser(user: {
  id: string
  username: string
  email: string
  name: string
  bio: string | null
  avatarUrl: string | null
  bannerUrl: string | null
  tags: string
  country: string | null
  createdAt: Date
  _count: { followers: number; following: number; posts: number }
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    tags: JSON.parse(user.tags) as string[],
    country: user.country,
    createdAt: user.createdAt,
    followersCount: user._count.followers,
    followingCount: user._count.following,
    postsCount: user._count.posts,
  }
}

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/lookup — resolve username → email (public, used for username login)
  app.post('/auth/lookup', async (request, reply) => {
    const { username } = (request.body as { username?: string }) ?? {}
    if (!username?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'username is required' })
    }
    const user = await prisma.user.findUnique({ where: { username }, select: { email: true } })
    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'Usuário não encontrado' })
    }
    return reply.send({ email: user.email })
  })


  // POST /auth/sync — called after Supabase signIn or signUp to create/retrieve profile
  app.post('/auth/sync', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string; email: string }
    const { username, name } = (request.body as { username?: string; name?: string }) ?? {}

    let user = await prisma.user.findUnique({
      where: { id: currentUser.id },
      include: { _count: { select: { followers: true, following: true, posts: true } } },
    })

    if (!user) {
      if (!username?.trim() || !name?.trim()) {
        return reply.status(200).send({ needsSetup: true })
      }

      if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Username inválido: use apenas letras minúsculas, números, ponto, underscore ou hífen (3-20 caracteres)',
        })
      }

      const taken = await prisma.user.findUnique({ where: { username } })
      if (taken) {
        return reply.status(409).send({ error: 'Conflict', message: 'Username already taken' })
      }

      user = await prisma.user.create({
        data: { id: currentUser.id, username, email: currentUser.email, name, tags: '[]' },
        include: { _count: { select: { followers: true, following: true, posts: true } } },
      })
    }

    return reply.send(serializeUser(user))
  })

  // GET /auth/me — returns current user profile (used on app init)
  app.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
      include: { _count: { select: { followers: true, following: true, posts: true } } },
    })

    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'Profile not found' })
    }

    return reply.send(serializeUser(user))
  })
}
