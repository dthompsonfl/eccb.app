export default function AdminRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The parent /(admin)/layout.tsx owns the canonical guard and shell.
  // Keeping this route-group layout transparent prevents nested sidebars,
  // duplicated navigation, and conflicting responsive offsets.
  return children;
}
