import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';
import { prisma } from '@/lib/db';
import { magicLink, twoFactor, admin, openAPI } from 'better-auth/plugins';
import { sendEmail } from '@/lib/email';
import { env } from '@/lib/env';
import { getAllowedOrigins, shouldUseSecureCookies } from '@/lib/allowed-origins';
import { IMPERSONATION_BA_ROLE } from '@/lib/auth/impersonation';

/**
 * Better Auth access-control instance for the admin plugin.
 *
 * Defined here (rather than inline in the plugin options) because
 * `src/lib/auth/impersonation.ts` needs the same role name to stamp onto
 * actors; keeping one definition prevents the grant and the assignment from
 * drifting apart, which would either lock every admin out of impersonation or
 * silently widen it.
 */
const ECCB_ADMIN_AC = createAccessControl(defaultStatements);

/**
 * Escape HTML entities to prevent injection in email body content.
 * Only call on user-supplied strings before interpolation into HTML.
 */
function htmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Session configuration constants
const SESSION_CONFIG = {
  // Session expiration: 7 days
  EXPIRES_IN: 60 * 60 * 24 * 7,
  // Session refresh interval: 1 day
  UPDATE_AGE: 60 * 60 * 24,
  // Cookie cache: 5 minutes
  COOKIE_CACHE_MAX_AGE: 60 * 5,
  // Password reset token expiration: 15 minutes
  PASSWORD_RESET_EXPIRATION: 60 * 15,
  // Email verification token expiration: 24 hours
  EMAIL_VERIFICATION_EXPIRATION: 60 * 60 * 24,
} as const;

/**
 * Whether session cookies carry the `Secure` attribute.
 *
 * Derived from the deployed scheme (see `shouldUseSecureCookies`) rather than
 * `NODE_ENV`, so an http:// deployment on any network interface still gets a
 * usable session cookie while an https:// deployment keeps the strict default.
 */
const useSecureCookies = shouldUseSecureCookies();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'mysql',
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Password reset token expiration (15 minutes)
    resetPasswordTokenExpiresIn: SESSION_CONFIG.PASSWORD_RESET_EXPIRATION,
    sendResetPassword: async ({ user, url }: { user: { email: string; name?: string | null }; url: string }) => {
      const safeName = user.name ? htmlEscape(user.name) : 'there';
      await sendEmail({
        to: user.email,
        subject: 'Reset your password - ECCB Platform',
        html: `
          <h2>Password Reset Request</h2>
          <p>Hi ${safeName},</p>
          <p>We received a request to reset your password. Click the link below to create a new password:</p>
          <p><a href="${url}" style="padding: 12px 24px; background: #0f766e; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a></p>
          <p>Or copy this link: ${url}</p>
          <p><strong>This link will expire in 15 minutes.</strong></p>
          <p>If you didn't request this password reset, please ignore this email. Your password will remain unchanged.</p>
          <p>For security, this link can only be used once.</p>
        `,
        text: `Reset your password by visiting: ${url}\n\nThis link expires in 15 minutes.`,
      });
    },
    // Callback after password reset for logging/security
    onPasswordReset: async ({ user }: { user: { id: string; email: string } }) => {
      // Log the password reset event
      console.log(`Password reset completed for user: ${user.email}`);
      // Could trigger session invalidation here if needed
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }: { user: { email: string; name?: string | null }; url: string }) => {
      const safeName = user.name ? htmlEscape(user.name) : 'there';
      void sendEmail({
        to: user.email,
        subject: 'Verify your email - ECCB Platform',
        html: `
          <h2>Welcome to ECCB Platform!</h2>
          <p>Hi ${safeName},</p>
          <p>Please verify your email address by clicking the link below:</p>
          <p><a href="${url}" style="padding: 12px 24px; background: #0f766e; color: white; text-decoration: none; border-radius: 6px;">Verify Email</a></p>
          <p>Or copy this link: ${url}</p>
          <p><strong>This link will expire in 24 hours.</strong></p>
          <p>If you didn't create an account, please ignore this email.</p>
        `,
        text: `Verify your email by visiting: ${url}\n\nThis link expires in 24 hours.`,
      }).catch((error) => {
        console.error('Failed to send verification email:', error);
      });
    },
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: SESSION_CONFIG.EMAIL_VERIFICATION_EXPIRATION,
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: 'Sign in to ECCB Platform',
          html: `
            <h2>Magic Link Sign In</h2>
            <p>Click the link below to sign in to your account:</p>
            <p><a href="${url}" style="padding: 12px 24px; background: #0f766e; color: white; text-decoration: none; border-radius: 6px;">Sign In</a></p>
            <p>Or copy this link: ${url}</p>
            <p><strong>This link will expire in 15 minutes.</strong></p>
            <p>If you didn't request this sign in link, please ignore this email.</p>
          `,
          text: `Click the link below to sign in:\n\n${url}\n\nThis link expires in 15 minutes.`,
        });
      },
      // Magic link expiration: 15 minutes
      expiresIn: SESSION_CONFIG.PASSWORD_RESET_EXPIRATION,
    }),
    twoFactor({
      issuer: env.NEXT_PUBLIC_APP_NAME,
      // Do not let enrolment succeed without a final TOTP verification, and do
      // not allow a factor to be enabled without a password check.
      skipVerificationOnEnable: false,
    }),
    admin({
      ac: ECCB_ADMIN_AC,
      roles: {
        // Every authenticated user is 'user' with no admin statements.
        user: ECCB_ADMIN_AC.newRole({ user: [], session: [] }),
        // Impersonation ONLY. Deliberately NOT 'admin': the stock admin
        // role also grants ban / delete / set-password / set-role on
        // /api/auth/*, which would bypass this application's own RBAC
        // (src/lib/auth/permission-constants.ts) and its audit log. Granting
        // exactly one statement keeps admin user management auditable here.
        [IMPERSONATION_BA_ROLE]: ECCB_ADMIN_AC.newRole({ user: ['impersonate'] }),
      },
      defaultRole: 'user',
      // Better Auth validates that every name in `adminRoles` exists in
      // `roles`. We deliberately never assign the stock 'admin' role — it would
      // also grant ban/delete/set-password on /api/auth/*, bypassing this
      // application's own RBAC and audit log. The only admin-ish role that
      // exists here is the impersonation-only support role.
      adminRoles: [IMPERSONATION_BA_ROLE],
      // Short-lived impersonation sessions.
      impersonationSessionDuration: 15 * 60,
    }),
    openAPI(),
  ],
  session: {
    // Session expiration: 7 days
    expiresIn: SESSION_CONFIG.EXPIRES_IN,
    // Session refresh interval: 1 day (how often to update session)
    updateAge: SESSION_CONFIG.UPDATE_AGE,
    // Cookie caching for performance
    cookieCache: {
      enabled: true,
      maxAge: SESSION_CONFIG.COOKIE_CACHE_MAX_AGE,
    },
    // Store sessions in database for persistence and management
    storeSessionInDatabase: true,
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Every origin this deployment answers on (canonical APP_URL + ALLOWED_ORIGINS).
  // A single-entry list makes Better Auth reject sign-in POSTs from the LAN /
  // Tailscale / public-IP origins as untrusted, which is what makes login
  // "submit then bounce" on any interface but the canonical one.
  trustedOrigins: [...getAllowedOrigins()],
  // Secure cookie configuration
  cookies: {
    sessionToken: {
      name: 'better-auth.session_token',
      attributes: {
        httpOnly: true,
        // 'lax' in every environment: 'strict' is fine for same-origin use,
        // but it drops the cookie on the OAuth/SSO top-level navigations that
        // Better Auth performs during password-reset and social sign-in.
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        // No `domain` attribute on purpose — host-only cookies.
        //
        // The reachable hosts (localhost, a LAN IP, a Tailscale IP, a public
        // IP) share no registrable parent domain, so a `Domain=localhost`
        // cookie would be REJECTED by the browser on every other host, leaving
        // the user authenticated-but-stateless (every request 401s, login
        // appears to loop). Host-only cookies work on all of them and are also
        // the tighter default.
      },
    },
    csrfToken: {
      name: 'better-auth.csrf_token',
      attributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
    state: {
      name: 'better-auth.state',
      attributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        maxAge: SESSION_CONFIG.PASSWORD_RESET_EXPIRATION, // 15 minutes
      },
    },
    pkceCodeVerifier: {
      name: 'better-auth.pkce_code_verifier',
      attributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        maxAge: SESSION_CONFIG.PASSWORD_RESET_EXPIRATION, // 15 minutes
      },
    },
    dontRememberToken: {
      name: 'better-auth.dont_remember',
      attributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        maxAge: 60 * 60 * 24 * 365, // 1 year
      },
    },
  },
  // Advanced security settings
  advanced: {
    // Secure cookies follow the deployed scheme, not NODE_ENV. Keying this off
    // NODE_ENV sets `Secure` on an http:// origin, where browsers silently
    // discard the cookie — which reads exactly like "login is broken".
    useSecureCookies,
    // Disable debug in production
    debug: env.NODE_ENV === 'development',
    // Host-only cookies: cross-subdomain sharing is intentionally disabled
    // because there is no common parent domain across the reachable hosts.
    // See the sessionToken comment above.
    crossSubDomainCookies: {
      enabled: false,
    },
  },
  // Rate limiting configuration (handled at API level, but Better Auth has built-in)
  rateLimit: {
    // Enable built-in rate limiting only in production to avoid local/E2E test pollution
    enabled: env.NODE_ENV === 'production',
    // Window for rate limiting (in seconds)
    window: 60,
    // Max requests per window
    max: 10,
  },
});

export type Session = typeof auth.$Infer.Session;
