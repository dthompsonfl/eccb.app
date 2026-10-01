import 'dotenv/config';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';
import { USER_MANAGE } from '@/lib/auth/permission-constants';

/**
 * End-to-end check of the impersonation module against the live DB, using the
 * same code path the route handler uses.
 */

function jar(list: string[], base = ''): string {
  const m = new Map<string, string>();
  for (const pair of base ? base.split('; ') : []) {
    const eq = pair.indexOf('=');
    if (eq > 0) m.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const n = pair.slice(0, eq);
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(raw)) m.delete(n);
    else m.set(n, pair.slice(eq + 1));
  }
  return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function main() {
  const { startImpersonation, stopImpersonation } = await import('@/lib/auth/impersonation');
  const { checkUserPermission } = await import('@/lib/auth/permissions');

  const stamp = Date.now();
  const pw = 'Passw0rd!xyz';
  const adminEmail = `e2e-admin-${stamp}@eccb.test`;
  const targetEmail = `e2e-target-${stamp}@eccb.test`;

  await auth.api.signUpEmail({ body: { email: adminEmail, password: pw, name: 'A' } });
  await auth.api.signUpEmail({ body: { email: targetEmail, password: pw, name: 'T' } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
  const target = await prisma.user.findUniqueOrThrow({ where: { email: targetEmail } });
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, target.id] } },
    data: { emailVerified: true },
  });

  // Grant the app's canonical permission + the framework role the plugin needs.
  const role = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: { name: 'SUPER_ADMIN', displayName: 'Super Administrator', type: 'SUPER_ADMIN' },
  });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'admin' } });

  console.log('A_APP_PERMISSION_GRANTED', await checkUserPermission(admin.id, USER_MANAGE));

  const cookie = jar(
    (await auth.api.signInEmail({ body: { email: adminEmail, password: pw }, asResponse: true }))
      .headers.getSetCookie(),
  );

  const start = await startImpersonation(target.id, new Headers({ cookie }));
  console.log('B_START_SUCCESS', start.success === true);
  if (!start.success) {
    console.log('   error:', start.error);
    return;
  }

  const sess = await prisma.session.findFirst({ where: { userId: target.id } });
  console.log('C_SESSION_ATTRIBUTED_TO_ACTOR', sess?.impersonatedBy === admin.id);
  console.log('D_COOKIES_FORWARDED', start.setCookies.length);

  const asTarget = await auth.api.getSession({ headers: new Headers({ cookie: jar(start.setCookies) }) });
  console.log('E_BROWSER_IS_NOW_TARGET', asTarget?.user?.email === targetEmail);

  const stop = await stopImpersonation(new Headers({ cookie: jar(start.setCookies) }));
  console.log('F_STOP_SUCCESS', stop.success === true);
  console.log('G_TARGET_SESSION_DELETED', (await prisma.session.count({ where: { userId: target.id } })) === 0);
  const restored = await auth.api.getSession({ headers: new Headers({ cookie: jar(stop.setCookies!) }) });
  console.log('H_ADMIN_SESSION_RESTORED', restored?.user?.email === adminEmail);

  // Privilege escalation: an admin target must be refused.
  const adminAsTarget = await startImpersonation(admin.id, new Headers({ cookie }));
  console.log('I_ADMIN_TARGET_REFUSED', adminAsTarget.success === false, adminAsTarget.success === false ? '' : '');

  await prisma.$disconnect();
}
main().catch((e) => {
  console.error('FATAL', String(e).slice(0, 500));
  process.exit(1);
});