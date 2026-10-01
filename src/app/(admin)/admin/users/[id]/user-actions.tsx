'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  MoreHorizontal,
  Mail,
  Shield,
  ShieldOff,
  Trash2,
  UserRound,
  LogOut,
} from 'lucide-react';
import type { UserWithDetails } from '../actions';

interface UserActionsProps {
  user: UserWithDetails;
}

export function UserActions({ user }: UserActionsProps) {
  const router = useRouter();
  const [showBanDialog, setShowBanDialog] = useState(false);
  const [showUnbanDialog, setShowUnbanDialog] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showImpersonateDialog, setShowImpersonateDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [banReason, setBanReason] = useState('');
  const [banExpires, setBanExpires] = useState('');

  const handleBan = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          banReason,
          banExpires: banExpires ? new Date(banExpires) : undefined,
        }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('User banned successfully');
        setShowBanDialog(false);
        router.refresh();
      } else {
        toast.error(data.error || 'Failed to ban user');
      }
    } catch {
      toast.error('Failed to ban user');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnban = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/unban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('User unbanned successfully');
        setShowUnbanDialog(false);
        router.refresh();
      } else {
        toast.error(data.error || 'Failed to unban user');
      }
    } catch {
      toast.error('Failed to unban user');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('Password reset email sent');
        setShowResetDialog(false);
      } else {
        toast.error(data.error || 'Failed to send password reset');
      }
    } catch {
      toast.error('Failed to send password reset');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('User deleted successfully');
        setShowDeleteDialog(false);
        router.push('/admin/users');
      } else {
        toast.error(data.error || 'Failed to delete user');
      }
    } catch {
      toast.error('Failed to delete user');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImpersonate = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('Impersonation started. Redirecting...');
        setShowImpersonateDialog(false);
        // The response carried Set-Cookie headers that established the
        // impersonation session, so a full reload is required — a
        // client-side navigation would keep rendering the admin identity.
        window.location.href = '/member';
      } else {
        toast.error(data.error || 'Failed to impersonate user');
      }
    } catch {
      toast.error('Failed to impersonate user');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevokeSessions = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/users/sessions/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(`${data.count} sessions revoked`);
        router.refresh();
      } else {
        toast.error(data.error || 'Failed to revoke sessions');
      }
    } catch {
      toast.error('Failed to revoke sessions');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            Actions
            <MoreHorizontal className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>User Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={() => setShowResetDialog(true)}>
            <Mail className="mr-2 h-4 w-4" />
            Send Password Reset
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => setShowImpersonateDialog(true)}>
            <UserRound className="mr-2 h-4 w-4" />
            Impersonate User
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={handleRevokeSessions}>
            <LogOut className="mr-2 h-4 w-4" />
            Revoke All Sessions
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          
          {user.banned ? (
            <DropdownMenuItem onClick={() => setShowUnbanDialog(true)}>
              <Shield className="mr-2 h-4 w-4" />
              Unban User
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem 
              onClick={() => setShowBanDialog(true)}
              className="text-destructive"
            >
              <ShieldOff className="mr-2 h-4 w-4" />
              Ban User
            </DropdownMenuItem>
          )}
          
          <DropdownMenuSeparator />
          
          <DropdownMenuItem 
            onClick={() => setShowDeleteDialog(true)}
            className="text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete User
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Ban Dialog */}
      <Dialog open={showBanDialog} onOpenChange={setShowBanDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ban User</DialogTitle>
            <DialogDescription>
              Ban this user from accessing the platform. They will be immediately
              logged out and unable to sign in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="banReason">Reason (optional)</Label>
              <Textarea
                id="banReason"
                placeholder="Enter reason for banning..."
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="banExpires">Expiration (optional)</Label>
              <Input
                id="banExpires"
                type="datetime-local"
                value={banExpires}
                onChange={(e) => setBanExpires(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Leave empty for a permanent ban
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBanDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBan} disabled={isLoading}>
              {isLoading ? 'Banning...' : 'Ban User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unban Dialog */}
      <Dialog open={showUnbanDialog} onOpenChange={setShowUnbanDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unban User</DialogTitle>
            <DialogDescription>
              Restore access for this user. They will be able to sign in again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUnbanDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleUnban} disabled={isLoading}>
              {isLoading ? 'Unbanning...' : 'Unban User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Reset Dialog */}
      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Password Reset</DialogTitle>
            <DialogDescription>
              Send a password reset email to {user.email}. The link will expire in
              15 minutes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handlePasswordReset} disabled={isLoading}>
              {isLoading ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this user? This action cannot be undone.
              All associated data will be removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isLoading}>
              {isLoading ? 'Deleting...' : 'Delete User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Impersonate Dialog */}
      <Dialog open={showImpersonateDialog} onOpenChange={setShowImpersonateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Impersonate User</DialogTitle>
            <DialogDescription>
              You will be logged in as {user.email} for support purposes. This action
              will be logged for security audit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImpersonateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleImpersonate} disabled={isLoading}>
              {isLoading ? 'Starting...' : 'Start Impersonation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
