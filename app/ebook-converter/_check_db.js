const {PrismaClient} = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  // Find the character row named Trương Túy
  const ch = await p.character.findMany({where: {name: {contains: 'Túy'}}});
  for (const c of ch) {
    const book = await p.book.findUnique({where: {id: c.bookId}});
    console.log(`"${c.name}" in book "${book?.title}" (${book?.id})`);
    console.log(`  aliases: ${c.aliases}`);
    console.log(`  voice: ${c.voice?.builtinName || c.voice?.name || 'none'}`);
    console.log(`  gender: ${c.gender}, tone: ${c.tone}`);
  }
  // Also check Tiểu Mai + Maiko + người đàn ông
  for (const name of ['Tiểu Mai', 'Maiko', 'người đàn ông 1', 'người đàn ông 2']) {
    const ch2 = await p.character.findMany({where: {name}});
    for (const c of ch2) {
      const book = await p.book.findUnique({where: {id: c.bookId}});
      console.log(`"${c.name}" in book "${book?.title}"`);
      console.log(`  aliases: ${c.aliases}`);
      console.log(`  voice: ${c.voice?.builtinName || c.voice?.name || 'none'}`);
      console.log(`  gender: ${c.gender}, tone: ${c.tone}, age: ${c.age}`);
    }
  }
  await p.$disconnect();
})();
