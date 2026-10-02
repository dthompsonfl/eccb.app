import { PublicNavigation } from '@/components/public/navigation';
import { PublicFooter } from '@/components/public/footer';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  // The public navigation is fixed at the top; use a single source of truth
  // for header spacing via the CSS variable `--site-header-height`.
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicNavigation />

      <main
        id="main-content"
        className="flex-1"
        // Use CSS var so header height can be tuned globally in globals.css
        style={{ paddingTop: 'var(--site-header-height, 4rem)' }}
        role="main"
      >
        {children}
      </main>

      <PublicFooter />
    </div>
  );
}
