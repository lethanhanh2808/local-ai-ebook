const {PrismaClient} = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const book = await p.book.findUnique({where:{id:'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314'}});
  console.log('Book:', book.title);
  const voices = await p.voice.findMany({where:{bookId:'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314'}});
  for (const v of voices) {
    console.log(`  ${v.isDefault ? '[DEFAULT]' : '       '} ${v.name} (${v.kind}, builtin=${v.builtinName})`);
  }
  await p.$disconnect();
})();
