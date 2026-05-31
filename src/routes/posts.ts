import { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/authenticate'
import { notifEmitter } from '../lib/notifEmitter'

export async function postRoutes(app: FastifyInstance) {
  // POST /posts — create post (auth required)
  app.post('/posts', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const { content, imageUrl } = request.body as { content: string; imageUrl?: string }

    if (!content?.trim() && !imageUrl?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'content or image is required' })
    }
    if (content && content.length > 500) {
      return reply.status(400).send({ error: 'Bad Request', message: 'content must be 500 characters or less' })
    }

    const post = await prisma.post.create({
      data: { content: content?.trim() ?? '', imageUrl: imageUrl ?? null, authorId: currentUser.id },
      include: {
        author: { select: { id: true, username: true, name: true, avatarUrl: true, tags: true } },
        _count: { select: { likes: true, comments: true } },
      },
    })

    return reply.status(201).send({
      id: post.id,
      content: post.content,
      imageUrl: post.imageUrl,
      createdAt: post.createdAt,
      author: { ...post.author, tags: JSON.parse(post.author.tags) },
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      likedByMe: false,
    })
  })

  // GET /posts/feed — feed from follows + own (auth required)
  app.get('/posts/feed', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }

    const query = request.query as { page?: string; limit?: string }
    const page = Math.max(1, parseInt(query.page ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '20', 10)))
    const skip = (page - 1) * limit

    const follows = await prisma.follow.findMany({
      where: { followerId: currentUser.id },
      select: { followingId: true },
    })

    const feedAuthorIds = [currentUser.id, ...follows.map((f) => f.followingId)]
    const followingSet = new Set(follows.map((f) => f.followingId))

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { authorId: { in: feedAuthorIds } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          author: { select: { id: true, username: true, name: true, avatarUrl: true, tags: true } },
          _count: { select: { likes: true, comments: true } },
          likes: { where: { userId: currentUser.id }, select: { id: true } },
        },
      }),
      prisma.post.count({ where: { authorId: { in: feedAuthorIds } } }),
    ])

    return reply.send({
      posts: posts.map((post) => ({
        id: post.id,
        content: post.content,
        imageUrl: post.imageUrl,
        createdAt: post.createdAt,
        author: { ...post.author, tags: JSON.parse(post.author.tags) },
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        likedByMe: post.likes.length > 0,
        authorIsFollowedByMe: followingSet.has(post.authorId),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + posts.length < total,
      },
    })
  })

  // GET /posts/explore — posts from users not followed by current user (optional auth)
  app.get('/posts/explore', async (request, reply) => {
    let currentUserId: string | null = null
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(authHeader.slice(7))
      if (data.user) currentUserId = data.user.id
    }

    const query = request.query as { page?: string; limit?: string }
    const page = Math.max(1, parseInt(query.page ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '20', 10)))
    const skip = (page - 1) * limit

    let excludeIds: string[] = []
    if (currentUserId) {
      const follows = await prisma.follow.findMany({
        where: { followerId: currentUserId },
        select: { followingId: true },
      })
      excludeIds = [currentUserId, ...follows.map((f) => f.followingId)]
    }

    const where = excludeIds.length > 0 ? { authorId: { notIn: excludeIds } } : {}

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          author: { select: { id: true, username: true, name: true, avatarUrl: true, tags: true } },
          _count: { select: { likes: true, comments: true } },
          likes: currentUserId ? { where: { userId: currentUserId }, select: { id: true } } : false,
        },
      }),
      prisma.post.count({ where }),
    ])

    return reply.send({
      posts: posts.map((post) => ({
        id: post.id,
        content: post.content,
        imageUrl: post.imageUrl,
        createdAt: post.createdAt,
        author: { ...post.author, tags: JSON.parse(post.author.tags) },
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        likedByMe: Array.isArray(post.likes) ? post.likes.length > 0 : false,
        authorIsFollowedByMe: false,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + posts.length < total,
      },
    })
  })

  // GET /posts/user/:username — posts by a specific user
  app.get('/posts/user/:username', async (request, reply) => {
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

    const [posts, followRecord] = await Promise.all([
      prisma.post.findMany({
        where: { authorId: user.id },
        orderBy: { createdAt: 'desc' },
        include: {
          author: { select: { id: true, username: true, name: true, avatarUrl: true, tags: true } },
          _count: { select: { likes: true, comments: true } },
          likes: currentUserId ? { where: { userId: currentUserId }, select: { id: true } } : false,
        },
      }),
      currentUserId && currentUserId !== user.id
        ? prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: currentUserId, followingId: user.id } },
          })
        : null,
    ])

    const authorIsFollowedByMe = !!followRecord

    return reply.send(
      posts.map((post) => ({
        id: post.id,
        content: post.content,
        imageUrl: post.imageUrl,
        createdAt: post.createdAt,
        author: { ...post.author, tags: JSON.parse(post.author.tags) },
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        likedByMe: Array.isArray(post.likes) ? post.likes.length > 0 : false,
        authorIsFollowedByMe,
      }))
    )
  })

  // GET /posts/:id — single post with comments (optional auth for likedByMe)
  app.get('/posts/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    let currentUserId: string | null = null
    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(authHeader.slice(7))
      if (data.user) currentUserId = data.user.id
    }

    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, username: true, name: true, avatarUrl: true, tags: true } },
        _count: { select: { likes: true, comments: true } },
        likes: currentUserId ? { where: { userId: currentUserId }, select: { id: true } } : false,
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
        },
      },
    })

    if (!post) {
      return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })
    }

    return reply.send({
      id: post.id,
      content: post.content,
      imageUrl: post.imageUrl,
      createdAt: post.createdAt,
      author: { ...post.author, tags: JSON.parse(post.author.tags) },
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      likedByMe: Array.isArray(post.likes) ? post.likes.length > 0 : false,
      comments: post.comments.map((c) => ({
        id: c.id,
        content: c.content,
        createdAt: c.createdAt,
        user: c.user,
      })),
    })
  })

  // DELETE /posts/:id — delete own post (auth required)
  app.delete('/posts/:id', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { id } = request.params as { id: string }

    const post = await prisma.post.findUnique({ where: { id } })
    if (!post) return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })
    if (post.authorId !== currentUser.id) return reply.status(403).send({ error: 'Forbidden', message: 'Not your post' })

    await prisma.post.delete({ where: { id } })
    return reply.send({ message: 'Post deleted' })
  })

  // POST /posts/:id/like (auth required)
  app.post('/posts/:id/like', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { id } = request.params as { id: string }

    const post = await prisma.post.findUnique({ where: { id } })
    if (!post) return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })

    const existing = await prisma.like.findUnique({
      where: { userId_postId: { userId: currentUser.id, postId: id } },
    })
    if (existing) return reply.status(409).send({ error: 'Conflict', message: 'Already liked' })

    await prisma.like.create({ data: { userId: currentUser.id, postId: id } })
    const likeCount = await prisma.like.count({ where: { postId: id } })
    if (post.authorId !== currentUser.id) {
      const notif = await prisma.notification.create({
        data: { recipientId: post.authorId, actorId: currentUser.id, type: 'LIKE', postId: id },
        include: { actor: { select: { id: true, username: true, name: true, avatarUrl: true } } },
      })
      notifEmitter.emit(`user:${post.authorId}`, {
        id: notif.id, type: 'LIKE', read: false, createdAt: notif.createdAt,
        actor: notif.actor,
        post: { id: post.id, imageUrl: post.imageUrl, content: post.content },
      })
    }
    return reply.status(201).send({ message: 'Post liked', likeCount })
  })

  // DELETE /posts/:id/like (auth required)
  app.delete('/posts/:id/like', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { id } = request.params as { id: string }

    const post = await prisma.post.findUnique({ where: { id } })
    if (!post) return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })

    const existing = await prisma.like.findUnique({
      where: { userId_postId: { userId: currentUser.id, postId: id } },
    })
    if (!existing) return reply.status(404).send({ error: 'Not Found', message: 'You have not liked this post' })

    await Promise.all([
      prisma.like.delete({ where: { userId_postId: { userId: currentUser.id, postId: id } } }),
      prisma.notification.deleteMany({
        where: { recipientId: post.authorId, actorId: currentUser.id, type: 'LIKE', postId: id },
      }),
    ])
    const likeCount = await prisma.like.count({ where: { postId: id } })
    return reply.send({ message: 'Post unliked', likeCount })
  })

  // GET /posts/:id/comments — list comments
  app.get('/posts/:id/comments', async (request, reply) => {
    const { id } = request.params as { id: string }
    const post = await prisma.post.findUnique({ where: { id } })
    if (!post) return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })

    const comments = await prisma.comment.findMany({
      where: { postId: id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
    })

    return reply.send(comments.map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      author: c.user,
    })))
  })

  // DELETE /posts/:id/comments/:commentId (auth required)
  app.delete('/posts/:id/comments/:commentId', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { id: postId, commentId } = request.params as { id: string; commentId: string }

    const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: { post: true } })
    if (!comment) return reply.status(404).send({ error: 'Not Found', message: 'Comment not found' })
    if (comment.postId !== postId) return reply.status(400).send({ error: 'Bad Request', message: 'Comment does not belong to this post' })

    const isCommentAuthor = comment.userId === currentUser.id
    const isPostOwner = comment.post.authorId === currentUser.id
    if (!isCommentAuthor && !isPostOwner) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Not allowed' })
    }

    await prisma.comment.delete({ where: { id: commentId } })
    return reply.send({ message: 'Comment deleted' })
  })

  // POST /posts/:id/comments (auth required)
  app.post('/posts/:id/comments', { preHandler: authenticate }, async (request, reply) => {
    const currentUser = request.user as { id: string }
    const { id } = request.params as { id: string }
    const { content } = request.body as { content: string }

    if (!content?.trim()) return reply.status(400).send({ error: 'Bad Request', message: 'content is required' })
    if (content.length > 300) return reply.status(400).send({ error: 'Bad Request', message: 'Comment must be 300 chars or less' })

    const post = await prisma.post.findUnique({ where: { id } })
    if (!post) return reply.status(404).send({ error: 'Not Found', message: 'Post not found' })

    const comment = await prisma.comment.create({
      data: { content: content.trim(), userId: currentUser.id, postId: id },
      include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
    })

    if (post.authorId !== currentUser.id) {
      const notif = await prisma.notification.create({
        data: {
          recipientId: post.authorId,
          actorId: currentUser.id,
          type: 'COMMENT',
          postId: id,
          commentContent: content.trim().slice(0, 100),
        },
        include: { actor: { select: { id: true, username: true, name: true, avatarUrl: true } } },
      })
      notifEmitter.emit(`user:${post.authorId}`, {
        id: notif.id, type: 'COMMENT', read: false, createdAt: notif.createdAt,
        actor: notif.actor,
        post: { id: post.id, imageUrl: post.imageUrl, content: post.content },
        commentContent: notif.commentContent,
      })
    }

    return reply.status(201).send({ id: comment.id, content: comment.content, createdAt: comment.createdAt, author: comment.user })
  })
}
