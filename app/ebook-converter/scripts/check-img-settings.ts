import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const all: any[] = await (p as any).$queryRawUnsafe("SELECT imageProvider, length(imageApiKey) as klen, imageModel, imageStyle, imageMaxPerBook FROM Settings");
  if (all.length === 0) { console.log("no rows"); return; }
  const s = all[0];
  console.log('imageProvider:', s.imageProvider);
  console.log('imageApiKey length:', s.klen);
  console.log('imageModel:', s.imageModel);
  console.log('imageStyle:', s.imageStyle);
  console.log('imageMaxPerBook:', s.imageMaxPerBook);
  await p.$disconnect();
}
main().catch((e: any) => { console.error(e?.message || e); process.exit(1); });
