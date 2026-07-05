const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const bookId = 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314';
  const chars = await p.character.findMany({where:{bookId}, include:{voice:true}});
  console.log('=== CHARACTERS ===');
  for (const c of chars) {
    const v = c.voice;
    const vInfo = v ? `-> voice=${v.name} builtinName=${v.builtinName || '-'} kind=${v.kind || '?'}` : '(NO VOICE)';
    console.log(`  [${c.role}] ${c.name} g=${c.gender||'?'} age=${c.age||'?'} tone=${c.tone||'?'} ${vInfo}`);
  }
  console.log();
  const voices = await p.voice.findMany({where:{bookId}});
  console.log('=== VOICES ===');
  for (const v of voices) {
    console.log(`  [${v.kind || '?'}] ${v.name} builtin=${v.builtinName || '-'} def=${v.isDefault}`);
  }
  await p.$disconnect();
})();