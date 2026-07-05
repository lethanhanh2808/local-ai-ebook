const {PrismaClient} = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const voices = await p.voice.findMany({where:{bookId:'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314'}, orderBy:[{isDefault:'desc'},{createdAt:'asc'}]});
  console.log('Default voice resolution order:');
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    console.log(`  [${i}] ${v.isDefault ? '[DEFAULT]' : '         '} ${v.name} kind=${v.kind} builtin=${v.builtinName}`);
  }
  await p.$disconnect();
})();
