import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'

// This file re-exports follow-related routes as a standalone plugin.
// The actual follow/unfollow/followers/following endpoints live in users.ts
// so they share the /users/:username base path. This plugin is registered
// in server.ts for completeness and can be used to add standalone follow
// queries (e.g. checking if you follow someone).

export async function followRoutes(app: FastifyInstance) {
  // GET /follows/check/:username — check if authenticated user follows :username
  app.get('/follows/check/:username', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { username } = request.params as { username: string }

    const targetUser = await prisma.user.findUnique({ where: { username } })

    if (!targetUser) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
      },
    })

    return reply.send({ following: follow !== null })
  })

  // GET /follows/suggestions — users the authenticated user might want to follow
  app.get('/follows/suggestions', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const alreadyFollowing = await prisma.follow.findMany({
      where: { followerId: currentUser.id },
      select: { followingId: true },
    })

    const excludeIds = [currentUser.id, ...alreadyFollowing.map((f) => f.followingId)]

    const suggestions = await prisma.user.findMany({
      where: { id: { notIn: excludeIds } },
      select: {
        id: true,
        username: true,
        name: true,
        bio: true,
        avatarUrl: true,
        tags: true,
        _count: {
          select: { followers: true },
        },
      },
      orderBy: {
        followers: { _count: 'desc' },
      },
      take: 10,
    })

    return reply.send({
      suggestions: suggestions.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        bio: u.bio,
        avatarUrl: u.avatarUrl,
        tags: JSON.parse(u.tags),
        followersCount: u._count.followers,
      })),
    })
  })
}
