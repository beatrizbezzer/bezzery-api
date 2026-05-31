import { FastifyInstance } from 'fastify'
import { PassThrough } from 'stream'
import { prisma } from '../lib/prisma'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/authenticate'
import { notifEmitter } from '../lib/notifEmitter'

export async function notificationRoutes(app: FastifyInstance) {
  // GET /notifications
  app.get('/notifications', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { recipientId: currentUser.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          actor: { select: { id: true, username: true, name: true, avatarUrl: true } },
          post: { select: { id: true, imageUrl: true, content: true } },
        },
      }),
      prisma.notification.count({
        where: { recipientId: currentUser.id, read: false },
      }),
    ])

    const actorIds = [...new Set(notifications.map((n) => n.actorId))]
    const myFollows = await prisma.follow.findMany({
      where: { followerId: currentUser.id, followingId: { in: actorIds } },
      select: { followingId: true },
    })
    const followingSet = new Set(myFollows.map((f) => f.followingId))

    return reply.send({
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        read: n.read,
        createdAt: n.createdAt,
        commentContent: n.commentContent,
        actor: n.actor,
        post: n.post,
        actorIsFollowedByMe: followingSet.has(n.actorId),
      })),
      unreadCount,
    })
  })

  // PUT /notifications/read
  app.put('/notifications/read', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    await prisma.notification.updateMany({
      where: { recipientId: currentUser.id, read: false },
      data: { read: true },
    })
    return reply.send({ message: 'Notifications marked as read' })
  })

  // GET /notifications/stream — SSE (auth via query param, EventSource não suporta headers)
  app.get('/notifications/stream', async (request, reply) => {
    const { token } = request.query as { token?: string }

    if (!token) return reply.status(401).send({ error: 'Unauthorized', message: 'Missing token' })

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' })

    const userId = data.user.id
    const stream = new PassThrough()

    reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(stream)

    const send = (payload: unknown) => {
      try { stream.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* client gone */ }
    }

    const unreadCount = await prisma.notification.count({
      where: { recipientId: userId, read: false },
    })
    send({ type: 'init', unreadCount })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listener = (notif: any) => send({ type: 'notification', notification: notif })
    notifEmitter.on(`user:${userId}`, listener)

    const keepAlive = setInterval(() => {
      try { stream.write(':ping\n\n') } catch { /* client gone */ }
    }, 25000)

    request.raw.on('close', () => {
      notifEmitter.off(`user:${userId}`, listener)
      clearInterval(keepAlive)
      stream.end()
    })
  })
}
