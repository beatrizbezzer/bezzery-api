import { FastifyRequest, FastifyReply } from 'fastify'
import { supabase } from '../lib/supabase'

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or malformed token' })
  }
  const token = authHeader.slice(7)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' })
  }
  ;(request as FastifyRequest & { user: { id: string; email: string } }).user = {
    id: data.user.id,
    email: data.user.email ?? '',
  }
}
