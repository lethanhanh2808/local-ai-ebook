import { prisma } from '../src/lib/db/client';

async function main() {
  const bs = await prisma.book.findMany({ take: 20 });
  for (const b of bs) {
    console.log(`${b.id} — ${b.title}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
