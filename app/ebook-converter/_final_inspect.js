const {PrismaClient} = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const chars = await p.character.findMany({
    where: {bookId: 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314'},
    include: {voice: true},
    orderBy: {name: 'asc'},
  });
  console.log('Character'.padEnd(28), 'Gender'.padEnd(8), 'Age'.padEnd(8), 'Tone'.padEnd(10), 'Voice');
  console.log('-'.repeat(80));
  for (const c of chars) {
    console.log(
      c.name.padEnd(28),
      (c.gender || '?').padEnd(8),
      (c.age || '?').padEnd(8),
      (c.tone || '?').padEnd(10),
      c.voice?.builtinName || c.voice?.name || 'NONE'
    );
  }
  await p.$disconnect();
})();
