import { prisma } from '../src/lib/db/client';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: tsx scripts/show-conversation-state.ts <bookId>');
    process.exit(2);
  }
  const r = await prisma.bookConversationState.findUnique({ where: { bookId: id } });
  console.log(r);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
