import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'

import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { postRoutes } from './routes/posts'
import { followRoutes } from './routes/follows'
import { notificationRoutes } from './routes/notifications'

const app = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  },
})

async function bootstrap() {
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.addContentTypeParser(
    ['application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => { done(null, body || null) }
  )
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    if (!body || body.length === 0) done(null, null)
    else done(new Error('Unsupported Media Type'), undefined)
  })

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(postRoutes)
  await app.register(followRoutes)
  await app.register(notificationRoutes)

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error)
    if (error.validation) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Validation error', details: error.validation })
    }
    const statusCode = error.statusCode ?? 500
    return reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : error.name,
      message: statusCode === 500 ? 'An unexpected error occurred' : error.message,
    })
  })

  const port = Number(process.env.PORT ?? 3333)
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`Bezzery API running at http://localhost:${port}`)
}

bootstrap().catch((err) => { console.error(err); process.exit(1) })
