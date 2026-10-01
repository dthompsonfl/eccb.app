import { Breadcrumbs } from '@/components/shared/breadcrumbs';
import { PageForm } from '@/components/admin/pages/page-form';
import { createPage } from '../actions';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_EDIT } from '@/lib/auth/permission-constants';

export default async function NewPagePage() {
  // Authoring CMS content requires cms.edit.
  await requirePermission(CMS_EDIT);

  async function handleCreatePage(formData: FormData) {
    'use server';

    return createPage(formData);
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Admin', href: '/admin' },
          { label: 'Pages', href: '/admin/pages' },
          { label: 'New Page' },
        ]}
      />

      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Page</h1>
        <p className="text-muted-foreground">
          Create a new page for your website
        </p>
      </div>

      <PageForm onSubmit={handleCreatePage} />
    </div>
  );
}
