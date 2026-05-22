import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUser } from '../actions';
export default function NewUserPage() {
  async function handleCreateUser(formData: FormData) {
    'use server';

    const email = formData.get('email') as string;
    const name = formData.get('name') as string;
    const sendInvite = formData.get('sendInvite') === 'on';

    const result = await createUser(email, name || undefined, sendInvite);

    if (result.success && result.userId) {
      redirect(`/admin/users/${result.userId}`);
    }

    // If there's an error, we'd normally show it - for now just redirect
    redirect('/admin/users');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/users">
          <button className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to Users
          </button>
        </Link>
      </div>

      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight">Create User</h1>
        <p className="text-muted-foreground mt-2">
          Create a new user account. Optionally send an invitation email.
        </p>

        <form action={handleCreateUser} className="mt-6 space-y-6">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email <span className="text-destructive">*</span>
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              className="w-full px-3 py-2 border rounded-md"
              placeholder="user@example.com"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="name" className="text-sm font-medium">
              Name (optional)
            </label>
            <input
              type="text"
              id="name"
              name="name"
              className="w-full px-3 py-2 border rounded-md"
              placeholder="John Doe"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="sendInvite"
              name="sendInvite"
              defaultChecked
              className="h-4 w-4"
            />
            <label htmlFor="sendInvite" className="text-sm">
              Send invitation email to the user
            </label>
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Create User
            </button>
            <Link href="/admin/users">
              <button
                type="button"
                className="px-4 py-2 border rounded-md hover:bg-muted"
              >
                Cancel
              </button>
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
