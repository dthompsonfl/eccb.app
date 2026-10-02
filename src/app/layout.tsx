/* eslint-disable react-refresh/only-export-components */
import type { Metadata } from 'next';
import { Inter, Oswald } from 'next/font/google';
import './globals.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { ServiceWorkerRegistration } from '@/components/providers/service-worker-provider';
import { SkipToContent } from '@/components/ui/skip-to-content';
import { TextScaleProvider } from '@/components/accessibility/text-scale-provider';
import { TEXT_SCALE_PREPAINT_SCRIPT } from '@/lib/accessibility/text-scale-script';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const oswald = Oswald({
  subsets: ['latin'],
  variable: '--font-oswald',
});

const appName = process.env.NEXT_PUBLIC_APP_NAME || 'Emerald Coast Community Band';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3225';

export const metadata: Metadata = {
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description: 'Official website and member portal for the Emerald Coast Community Band',
  keywords: ['community band', 'music', 'emerald coast', 'florida', 'concert band'],
  authors: [{ name: appName }],
  creator: appName,
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: appUrl,
    siteName: appName,
    title: appName,
    description: 'Official website and member portal for the Emerald Coast Community Band',
  },
  twitter: {
    card: 'summary_large_image',
    title: appName,
    description: 'Official website and member portal for the Emerald Coast Community Band',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  // PWA disabled - manifest removed to prevent installability
  // To re-enable: add manifest: '/manifest.json' and create proper icons
  icons: {
    icon: '/favicon.ico',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the member's chosen text size BEFORE first paint. Inline and
            synchronous on purpose: a deferred or effect-based application would
            render at the default size and then jump. */}
        <script
          id="text-scale-prepaint"
          dangerouslySetInnerHTML={{ __html: TEXT_SCALE_PREPAINT_SCRIPT }}
        />
      </head>
      <body className={`${inter.variable} ${oswald.variable} font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TextScaleProvider>
            <SkipToContent />
            <ServiceWorkerRegistration />
            {children}
            <Toaster
              position="top-right"
              richColors
              closeButton
              expand={false}
            />
          </TextScaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
