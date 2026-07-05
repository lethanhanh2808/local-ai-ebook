// Set Bình An (male, calm narrator) as the default voice for the book.
// This makes narration and any un-attributed dialogue sound like a male
// narrator instead of falling back to the first common-pool voice (which
// happens to be Mỹ Duyên, female — and gets mistaken for a character).
const {PrismaClient} = require('@prisma/client');

const BOOK_ID = 'a95ed27c-ca5e-4e1e-bf30-b93c68f2e314';

(async () => {
  const p = new PrismaClient();
  const voices = await p.voice.findMany({where:{bookId:BOOK_ID}});
  // Find the Bình An voice row (or create one if missing — backfill should
  // have made it).
  let binhAn = voices.find(v => v.builtinName === 'Bình An');
  if (!binhAn) {
    // Create Bình An as default
    binhAn = await p.voice.create({
      data: {
        bookId: BOOK_ID,
        name: 'Bình An (Người dẫn chuyện)',
        refAudioPath: '',
        language: 'vi',
        isDefault: true,
        description: 'Default narrator voice — calm male, never assigned to a character.',
        kind: 'character',
        builtinName: 'Bình An',
      },
    });
    console.log('Created Bình An voice row as default.');
  } else {
    // Mark Bình An as default, unmark any other default
    await p.voice.updateMany({where:{bookId:BOOK_ID, isDefault:true, NOT:{id:binhAn.id}}, data:{isDefault:false}});
    await p.voice.update({where:{id:binhAn.id}, data:{isDefault:true}});
    console.log('Bình An marked as default.');
  }
  await p.$disconnect();
})();
