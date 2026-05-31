import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { supabase } from '../lib/supabase'
import { notifEmitter } from '../lib/notifEmitter'

async function getAuthUser(request: { headers: { authorization?: string } }) {
  const authHeader = request.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const { data: { user } } = await supabase.auth.getUser(token)
  return user
}

export async function messageRoutes(app: FastifyInstance) {
  // GET /conversations — list all conversations for current user
  app.get('/conversations', async (request, reply) => {
    const authUser = await getAuthUser(request)
    if (!authUser) return reply.status(401).send({ error: 'Unauthorized' })

    const participants = await prisma.conversationParticipant.findMany({
      where: { userId: authUser.id },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { conversation: { createdAt: 'desc' } },
    })

    const conversations = participants.map((p) => {
      const other = p.conversation.participants.find((cp) => cp.userId !== authUser.id)
      const lastMsg = p.conversation.messages[0] ?? null
      const unreadCount = 0 // computed separately if needed
      return {
        id: p.conversation.id,
        createdAt: p.conversation.createdAt,
        otherUser: other?.user ?? null,
        lastMessage: lastMsg
          ? { content: lastMsg.content, senderId: lastMsg.senderId, createdAt: lastMsg.createdAt, read: lastMsg.read }
          : null,
        unreadCount,
      }
    })

    return reply.send(conversations)
  })

  // POST /conversations — open or find existing conversation with a user
  app.post<{ Body: { userId: string } }>('/conversations', async (request, reply) => {
    const authUser = await getAuthUser(request)
    if (!authUser) return reply.status(401).send({ error: 'Unauthorized' })

    const { userId: targetUserId } = request.body
    if (!targetUserId || targetUserId === authUser.id) {
      return reply.status(400).send({ error: 'Invalid userId' })
    }

    // Verify mutual follow
    const [iFollow, theyFollow] = await Promise.all([
      prisma.follow.findUnique({ where: { followerId_followingId: { followerId: authUser.id, followingId: targetUserId } } }),
      prisma.follow.findUnique({ where: { followerId_followingId: { followerId: targetUserId, followingId: authUser.id } } }),
    ])
    if (!iFollow || !theyFollow) {
      return reply.status(403).send({ error: 'You must mutually follow each other to send messages' })
    }

    // Find existing conversation between these two
    const existing = await prisma.conversation.findFirst({
      where: {
        participants: { every: { userId: { in: [authUser.id, targetUserId] } } },
        AND: [
          { participants: { some: { userId: authUser.id } } },
          { participants: { some: { userId: targetUserId } } },
        ],
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
        },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })

    if (existing) {
      const other = existing.participants.find((cp) => cp.userId !== authUser.id)
      return reply.send({
        id: existing.id,
        createdAt: existing.createdAt,
        otherUser: other?.user ?? null,
        lastMessage: existing.messages[0] ?? null,
      })
    }

    const conv = await prisma.conversation.create({
      data: {
        participants: {
          create: [{ userId: authUser.id }, { userId: targetUserId }],
        },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
        },
      },
    })

    const other = conv.participants.find((cp) => cp.userId !== authUser.id)
    return reply.status(201).send({
      id: conv.id,
      createdAt: conv.createdAt,
      otherUser: other?.user ?? null,
      lastMessage: null,
    })
  })

  // GET /conversations/:id/messages
  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (request, reply) => {
    const authUser = await getAuthUser(request)
    if (!authUser) return reply.status(401).send({ error: 'Unauthorized' })

    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: request.params.id, userId: authUser.id } },
    })
    if (!participant) return reply.status(403).send({ error: 'Forbidden' })

    const messages = await prisma.message.findMany({
      where: { conversationId: request.params.id },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, username: true, name: true, avatarUrl: true } } },
    })

    // Mark messages from others as read
    await prisma.message.updateMany({
      where: { conversationId: request.params.id, senderId: { not: authUser.id }, read: false },
      data: { read: true },
    })

    return reply.send(messages)
  })

  // POST /conversations/:id/messages
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    '/conversations/:id/messages',
    async (request, reply) => {
      const authUser = await getAuthUser(request)
      if (!authUser) return reply.status(401).send({ error: 'Unauthorized' })

      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: request.params.id, userId: authUser.id } },
      })
      if (!participant) return reply.status(403).send({ error: 'Forbidden' })

      const { content } = request.body
      if (!content?.trim()) return reply.status(400).send({ error: 'Content required' })

      const [message, senderUser] = await Promise.all([
        prisma.message.create({
          data: { content: content.trim(), senderId: authUser.id, conversationId: request.params.id },
          include: { sender: { select: { id: true, username: true, name: true, avatarUrl: true } } },
        }),
        prisma.user.findUnique({ where: { id: authUser.id }, select: { id: true, username: true, name: true, avatarUrl: true } }),
      ])

      // Find the other participant and emit real-time event
      const otherParticipant = await prisma.conversationParticipant.findFirst({
        where: { conversationId: request.params.id, userId: { not: authUser.id } },
      })
      if (otherParticipant) {
        notifEmitter.emit(`user:${otherParticipant.userId}`, {
          type: 'message',
          conversationId: request.params.id,
          message: {
            id: message.id,
            content: message.content,
            senderId: message.senderId,
            sender: senderUser,
            createdAt: message.createdAt,
            read: false,
          },
        })
      }

      return reply.status(201).send(message)
    }
  )

  // GET /conversations/unread-count
  app.get('/conversations/unread-count', async (request, reply) => {
    const authUser = await getAuthUser(request)
    if (!authUser) return reply.status(401).send({ error: 'Unauthorized' })

    const count = await prisma.message.count({
      where: {
        read: false,
        senderId: { not: authUser.id },
        conversation: { participants: { some: { userId: authUser.id } } },
      },
    })

    return reply.send({ count })
  })
}
