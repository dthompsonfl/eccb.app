import 'dotenv/config';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';

function toCookieHeader(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function main() {
  const stamp = Date.now();
  const adminEmail = `probe-a-${stamp}@eccb.test`;
  const targetEmail = `probe-t-${stamp}@eccb.test`;
  await auth.api.signUpEmail({ body: { email: adminEmail, password: 'Passw0rd!xyz', name: 'A' } });
  await auth.api.signUpEmail({ body: { email: targetEmail, password: 'Passw0rd!xyz', name: 'T' } });
  const a = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
  const t = await prisma.user.findUniqueOrThrow({ where: { email: targetEmail } });
  await prisma.user.updateMany({ where: { id: { in: [a.id, t.id] } }, data: { emailVerified: true } });
  await prisma.user.update({ where: { id: a.id }, data: { role: 'admin' } });

  const res = await auth.api.signInEmail({ body: { email: adminEmail, password: 'Passw0rd!xyz' }, asResponse: true });
  const cookie = toCookieHeader(res.headers.getSetCookie());

  const r = await auth.api.impersonateUser({ body: { userId: t.id }, headers: new Headers({ cookie }), returnHeaders: true });
  const sess = await prisma.session.findFirst({ where: { userId: t.id } });
  console.log('IMPERSONATED_BY_MATCHES_ADMIN', sess?.impersonatedBy === a.id);

  const impCookie = toCookieHeader(r.headers.getSetCookie());
  const asTarget = await auth.api.getSession({ headers: new Headers({ cookie: impCookie }) });
  console.log('BROWSER_NOW_IS_TARGET', asTarget?.user?.email === targetEmail);

  const stop = await auth.api.stopImpersonating({ headers: new Headers({ cookie: impCookie }), returnHeaders: true });
  console.log('STOP_OK', !!stop?.response?.user, 'restored_to_admin=', stop?.response?.user?.email === adminEmail);
  console.log('IMP_SESSION_DELETED', (await prisma.session.count({ where: { userId: t.id } })) === 0);
  const restored = toCookieHeader(stop.headers.getSetCookie());
  const after = await auth.api.getSession({ headers: new Headers({ cookie: restored }) });
  console.log('ADMIN_SESSION_RESTORED', after?.user?.email === adminEmail);
  await prisma.$disconnect();
}
main().catch((e) => { console.error('FATAL', String(e).slice(0, 700)); process.exit(1); });
