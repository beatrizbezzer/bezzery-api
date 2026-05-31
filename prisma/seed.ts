import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // Clean up existing data
  await prisma.comment.deleteMany()
  await prisma.like.deleteMany()
  await prisma.follow.deleteMany()
  await prisma.post.deleteMany()
  await prisma.user.deleteMany()

  // Create users
  const password = await bcrypt.hash('password123', 10)

  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@bezzery.com',
      password,
      name: 'Alice Wonder',
      bio: 'Building things on the internet.',
      tags: JSON.stringify(['dev', 'design', 'typescript']),
    },
  })

  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@bezzery.com',
      password,
      name: 'Bob Builder',
      bio: 'Full-stack developer and coffee addict.',
      tags: JSON.stringify(['backend', 'nodejs', 'coffee']),
    },
  })

  const carol = await prisma.user.create({
    data: {
      username: 'carol',
      email: 'carol@bezzery.com',
      password,
      name: 'Carol Smith',
      bio: 'UX designer | making things people love.',
      tags: JSON.stringify(['design', 'ux', 'figma']),
    },
  })

  // Create follows
  await prisma.follow.createMany({
    data: [
      { followerId: alice.id, followingId: bob.id },
      { followerId: alice.id, followingId: carol.id },
      { followerId: bob.id, followingId: alice.id },
      { followerId: carol.id, followingId: alice.id },
    ],
  })

  // Create posts
  const post1 = await prisma.post.create({
    data: {
      content: 'Just shipped the Bezzery API! TypeScript + Fastify + Prisma feels amazing. 🚀',
      authorId: alice.id,
    },
  })

  const post2 = await prisma.post.create({
    data: {
      content: 'Hot take: SQLite is perfectly fine for most side projects. Stop over-engineering.',
      authorId: bob.id,
    },
  })

  const post3 = await prisma.post.create({
    data: {
      content: 'New design system dropped. Clean, minimal, and accessible by default.',
      authorId: carol.id,
    },
  })

  // Create likes
  await prisma.like.createMany({
    data: [
      { userId: bob.id, postId: post1.id },
      { userId: carol.id, postId: post1.id },
      { userId: alice.id, postId: post2.id },
      { userId: carol.id, postId: post2.id },
      { userId: alice.id, postId: post3.id },
      { userId: bob.id, postId: post3.id },
    ],
  })

  // Create comments
  await prisma.comment.createMany({
    data: [
      { content: 'Congrats! Prisma is such a pleasure to work with.', userId: bob.id, postId: post1.id },
      { content: 'Agreed! The DX is top tier.', userId: carol.id, postId: post1.id },
      { content: 'This. Premature optimization is the root of all evil.', userId: alice.id, postId: post2.id },
      { content: 'Looking forward to trying it out!', userId: bob.id, postId: post3.id },
    ],
  })

  console.log('Seed complete!')
  console.log('Users created: alice, bob, carol (password: password123)')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
