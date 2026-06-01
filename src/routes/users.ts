import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/authenticate'
import { notifEmitter } from '../lib/notifEmitter'

export async function userRoutes(app: FastifyInstance) {
  // GET /users/:username — public profile (optional auth for isFollowing)
  app.get('/users/:username', async (request, reply) => {
    const { username } = request.params as { username: string }

    let currentUserId: string | null = null
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(authHeader.slice(7))
      if (data.user) currentUserId = data.user.id
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
            posts: true,
          },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    let isFollowing = false
    if (currentUserId && currentUserId !== user.id) {
      const follow = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: currentUserId, followingId: user.id } },
      })
      isFollowing = !!follow
    }

    return reply.send({
      id: user.id,
      username: user.username,
      name: user.name,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      bgImage: user.bgImage,
      profileEffect: user.profileEffect,
      cardBorder: user.cardBorder,
      cardSticker: user.cardSticker,
      cardOverlay: user.cardOverlay,
      tags: JSON.parse(user.tags),
      country: user.country,
      createdAt: user.createdAt,
      followersCount: user._count.followers,
      followingCount: user._count.following,
      postsCount: user._count.posts,
      isFollowing,
    })
  })

  // GET /users/search?q= — search users by name or username (auth required)
  app.get('/users/search', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { q } = request.query as { q?: string }

    if (!q?.trim() || q.trim().length < 2) {
      return reply.send({ users: [] })
    }

    const term = q.trim().toLowerCase()

    const users = await prisma.user.findMany({
      where: {
        id: { not: currentUser.id },
        OR: [
          { username: { contains: term } },
          { name: { contains: term } },
        ],
      },
      take: 20,
      include: {
        followers: {
          where: { followerId: currentUser.id },
          select: { id: true },
        },
        _count: { select: { followers: true, following: true, posts: true } },
      },
    })

    return reply.send({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        avatarUrl: u.avatarUrl,
        bio: u.bio,
        followersCount: u._count.followers,
        followingCount: u._count.following,
        postsCount: u._count.posts,
        isFollowing: u.followers.length > 0,
      })),
    })
  })

  // PUT /users/me — update own profile (auth required)
  app.put('/users/me', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const { bio, avatarUrl, bannerUrl, bgImage, profileEffect, cardBorder, cardSticker, cardOverlay, tags, name, country } = request.body as {
      bio?: string
      avatarUrl?: string
      bannerUrl?: string
      bgImage?: string | null
      profileEffect?: string | null
      cardBorder?: string | null
      cardSticker?: string | null
      cardOverlay?: string | null
      tags?: string[]
      name?: string
      country?: string
    }

    const updateData: Record<string, unknown> = {}

    if (bio !== undefined) updateData.bio = bio
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl
    if (bannerUrl !== undefined) updateData.bannerUrl = bannerUrl
    if (bgImage !== undefined) updateData.bgImage = bgImage
    if (profileEffect !== undefined) updateData.profileEffect = profileEffect
    if (cardBorder !== undefined) updateData.cardBorder = cardBorder
    if (cardSticker !== undefined) updateData.cardSticker = cardSticker
    if (cardOverlay !== undefined) updateData.cardOverlay = cardOverlay
    if (country !== undefined) updateData.country = country
    if (name !== undefined) {
      if (!name.trim()) {
        return reply.status(400).send({ error: 'Bad Request', message: 'name cannot be empty' })
      }
      updateData.name = name
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return reply.status(400).send({ error: 'Bad Request', message: 'tags must be an array' })
      }
      updateData.tags = JSON.stringify(tags)
    }

    const user = await prisma.user.update({
      where: { id: currentUser.id },
      data: updateData,
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
            posts: true,
          },
        },
      },
    })

    return reply.send({
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      bgImage: user.bgImage,
      profileEffect: user.profileEffect,
      cardBorder: user.cardBorder,
      cardSticker: user.cardSticker,
      cardOverlay: user.cardOverlay,
      tags: JSON.parse(user.tags),
      country: user.country,
      createdAt: user.createdAt,
      followersCount: user._count.followers,
      followingCount: user._count.following,
      postsCount: user._count.posts,
    })
  })

  // GET /users/:username/followers
  app.get('/users/:username/followers', async (request, reply) => {
    const { username } = request.params as { username: string }

    let currentUserId: string | null = null
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(authHeader.slice(7))
      if (data.user) currentUserId = data.user.id
    }

    const user = await prisma.user.findUnique({ where: { username } })

    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    const follows = await prisma.follow.findMany({
      where: { followingId: user.id },
      include: {
        follower: {
          select: {
            id: true,
            username: true,
            name: true,
            bio: true,
            avatarUrl: true,
            tags: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    })

    let myFollowSet = new Set<string>()
    if (currentUserId) {
      const followerIds = follows.map((f) => f.follower.id)
      const myFollows = await prisma.follow.findMany({
        where: { followerId: currentUserId, followingId: { in: followerIds } },
        select: { followingId: true },
      })
      myFollowSet = new Set(myFollows.map((f) => f.followingId))
    }

    const followers = follows.map((f) => ({
      ...f.follower,
      tags: JSON.parse(f.follower.tags),
      isFollowing: myFollowSet.has(f.follower.id),
    }))

    return reply.send({ followers, count: followers.length })
  })

  // GET /users/:username/following
  app.get('/users/:username/following', async (request, reply) => {
    const { username } = request.params as { username: string }

    let currentUserId: string | null = null
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(authHeader.slice(7))
      if (data.user) currentUserId = data.user.id
    }

    const user = await prisma.user.findUnique({ where: { username } })

    if (!user) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    const follows = await prisma.follow.findMany({
      where: { followerId: user.id },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            name: true,
            bio: true,
            avatarUrl: true,
            tags: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    })

    let myFollowSet = new Set<string>()
    if (currentUserId) {
      const followingIds = follows.map((f) => f.following.id)
      const myFollows = await prisma.follow.findMany({
        where: { followerId: currentUserId, followingId: { in: followingIds } },
        select: { followingId: true },
      })
      myFollowSet = new Set(myFollows.map((f) => f.followingId))
    }

    const following = follows.map((f) => ({
      ...f.following,
      tags: JSON.parse(f.following.tags),
      isFollowing: myFollowSet.has(f.following.id),
    }))

    return reply.send({ following, count: following.length })
  })

  // POST /users/:username/follow — follow user (auth required)
  app.post('/users/:username/follow', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { username } = request.params as { username: string }

    const ownProfile = await prisma.user.findUnique({ where: { id: currentUser.id } })
    if (username === ownProfile?.username) {
      return reply.status(400).send({ error: 'Bad Request', message: 'You cannot follow yourself' })
    }

    const targetUser = await prisma.user.findUnique({ where: { username } })

    if (!targetUser) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    const existingFollow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
      },
    })

    if (existingFollow) {
      return reply.status(409).send({ error: 'Conflict', message: 'Already following this user' })
    }

    await prisma.follow.create({
      data: {
        followerId: currentUser.id,
        followingId: targetUser.id,
      },
    })

    const notif = await prisma.notification.create({
      data: { recipientId: targetUser.id, actorId: currentUser.id, type: 'FOLLOW' },
      include: { actor: { select: { id: true, username: true, name: true, avatarUrl: true } } },
    })
    notifEmitter.emit(`user:${targetUser.id}`, {
      id: notif.id, type: 'FOLLOW', read: false, createdAt: notif.createdAt,
      actor: notif.actor, post: null,
    })

    return reply.status(201).send({ message: `Now following @${username}` })
  })

  // DELETE /users/:username/follow — unfollow user (auth required)
  app.delete('/users/:username/follow', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { username } = request.params as { username: string }

    const targetUser = await prisma.user.findUnique({ where: { username } })

    if (!targetUser) {
      return reply.status(404).send({ error: 'Not Found', message: 'User not found' })
    }

    const existingFollow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
      },
    })

    if (!existingFollow) {
      return reply.status(404).send({ error: 'Not Found', message: 'You are not following this user' })
    }

    await prisma.follow.delete({
      where: {
        followerId_followingId: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
      },
    })

    return reply.send({ message: `Unfollowed @${username}` })
  })
}
