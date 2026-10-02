'use client';

import { useTheme } from 'next-themes';
import { Bell, Moon, Sun, LogOut, User, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Link from 'next/link';
import { signOut } from '@/lib/auth/client';
import { useRouter } from 'next/navigation';
import { HelpControl } from '@/components/accessibility/help-control';
import { TextSizeControl } from '@/components/accessibility/text-size-control';

interface MemberHeaderProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    member?: {
      firstName: string;
      lastName: string;
    } | null;
  } | null;
}

export function MemberHeader({ user }: MemberHeaderProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  const memberName = user?.member
    ? `${user.member.firstName} ${user.member.lastName}`
    : user?.name || 'Member';

  const handleSignOut = async () => {
    await signOut();
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-40 h-16 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-full items-center justify-between px-6">
        {/* Page title placeholder - can be dynamic */}
        <div className="lg:hidden" /> {/* Spacer for mobile menu button */}
        <div className="hidden lg:block" />

        {/* Right side actions */}
        <div className="flex items-center gap-2">
          {/* "Show me how" — always there, so the walkthrough is never lost */}
          <HelpControl />

          {/* Text size */}
          <TextSizeControl />

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Switch between light and dark"
          >
            <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>

          {/* Notifications */}
          <Button variant="ghost" size="icon" asChild>
            <Link href="/member/notifications">
              <Bell className="h-5 w-5" />
              <span className="sr-only">Messages</span>
            </Link>
          </Button>

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-4 w-4 text-primary" />
                </div>
                <span className="sr-only md:not-sr-only md:block max-w-[150px] truncate md:truncate">
                  {memberName}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span>{memberName}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {user?.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/member/profile">
                  <User className="mr-2 h-4 w-4" />
                  About Me
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/member/settings">
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
