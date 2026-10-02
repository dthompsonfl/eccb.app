'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Save, Eye, FileText, Settings, CalendarClock, CheckCircle2, Archive } from 'lucide-react';
import { normalizePageContent } from '@/lib/cms/page-content';
import { cn } from '@/lib/utils';
import type { PagePublishState } from '@/lib/cms/page-visibility';

const pageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  slug: z.string().min(1, 'URL slug is required').regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  description: z.string().optional(),
  content: z.string().optional(),
  rawMarkdown: z.string().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  ogImage: z.string().optional(),
  scheduledFor: z.string().optional(),
  publishAt: z.string().optional(),
});

type PageFormData = z.infer<typeof pageSchema>;

interface PageFormProps {
  initialData?: Partial<PageFormData> & { id?: string; content?: string | null };
  onSubmit: (formData: FormData) => Promise<{ success: boolean; error?: string; pageId?: string }>;
  isEdit?: boolean;
}

const statuses = [
  { value: 'DRAFT', label: 'Draft', description: 'Only visible to admins' },
  { value: 'SCHEDULED', label: 'Scheduled', description: 'Will be published at a future date' },
  { value: 'PUBLISHED', label: 'Published', description: 'Visible to everyone' },
  { value: 'ARCHIVED', label: 'Archived', description: 'No longer publicly visible' },
];

export function PageForm({
  initialData,
  onSubmit,
  isEdit = false,
}: PageFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('content');
  const [previewContent, setPreviewContent] = useState('');
  
  const normalizedInitialContent = normalizePageContent(initialData?.content ?? '');

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PageFormData>({
    resolver: zodResolver(pageSchema),
    defaultValues: {
      title: initialData?.title || '',
      slug: initialData?.slug || '',
      description: initialData?.description || '',
      content: normalizedInitialContent.body,
      rawMarkdown: initialData?.rawMarkdown || '',
      status: initialData?.status || 'DRAFT',
      metaTitle: initialData?.metaTitle || '',
      metaDescription: initialData?.metaDescription || '',
      ogImage: initialData?.ogImage || '',
      scheduledFor: initialData?.scheduledFor || '',
      publishAt: initialData?.publishAt || '',
    },
  });

  const watchedContent = watch('content');
  const watchedStatus = watch('status');
  const watchedPublishAt = watch('publishAt');
  const watchedScheduledFor = watch('scheduledFor');

  // The single instant the public visibility check reads: the canonical field
  // when set, otherwise the legacy one. Kept client-side purely so the banner
  // below reflects the true publish state — the server re-derives everything.
  const effectivePublishAt = useMemo(() => {
    const raw = watchedPublishAt || watchedScheduledFor;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [watchedPublishAt, watchedScheduledFor]);

  // Mirrors getPagePublishState so the badge can never disagree with what the
  // public site will serve.
  const publishState: PagePublishState = useMemo(() => {
    if (watchedStatus === 'ARCHIVED') return 'archived';
    if (watchedStatus === 'DRAFT') return 'draft';
    if (watchedStatus === 'SCHEDULED') return 'scheduled';
    if (effectivePublishAt && effectivePublishAt.getTime() > Date.now()) {
      return 'scheduled';
    }
    if (watchedStatus === 'PUBLISHED') return 'published';
    return 'draft';
  }, [watchedStatus, effectivePublishAt]);

  // Generate slug from title
  const generateSlug = useCallback(() => {
    const title = watch('title');
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    setValue('slug', slug);
  }, [setValue, watch]);

  // Handle form submission
  const handleFormSubmit = async (data: PageFormData) => {
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      Object.entries(data).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          formData.append(key, String(value));
        }
      });

      const result = await onSubmit(formData);

      if (result.success) {
        toast.success(isEdit ? 'Page updated successfully!' : 'Page created successfully!');
        if (result.pageId) {
          router.push(`/admin/pages/${result.pageId}`);
        } else {
          router.push('/admin/pages');
        }
      } else {
        toast.error(result.error || 'Failed to save page');
      }
    } catch (_error) {
      toast.error('Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Preview the page
  const handlePreview = () => {
    const content = watch('content') || '';
    setPreviewContent(content);
    setActiveTab('preview');
  };

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content Area */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Page Details</CardTitle>
              <CardDescription>
                Basic information about this page
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  placeholder="e.g., About Us"
                  {...register('title')}
                  aria-invalid={!!errors.title}
                />
                {errors.title && (
                  <p className="text-sm text-destructive">{errors.title.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="slug">URL Slug *</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={generateSlug}
                    className="text-xs"
                  >
                    Generate from title
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">/</span>
                  <Input
                    id="slug"
                    placeholder="about-us"
                    {...register('slug')}
                    aria-invalid={!!errors.slug}
                    className="flex-1"
                  />
                </div>
                {errors.slug && (
                  <p className="text-sm text-destructive">{errors.slug.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Brief description for previews and search results..."
                  rows={2}
                  {...register('description')}
                />
              </div>
            </CardContent>
          </Card>

          {/* Content Editor */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Page Content
              </CardTitle>
              <CardDescription>
                Write your page content using Markdown
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                  <TabsTrigger value="content">Edit</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>
                <TabsContent value="content">
                  <Textarea
                    id="content"
                    placeholder="# Page Title

Write your content here using Markdown...

## Section Heading

- Bullet points
- Are easy to use

**Bold** and *italic* text are supported."
                    rows={20}
                    className="font-mono text-sm"
                    {...register('content')}
                  />
                </TabsContent>
                <TabsContent value="preview">
                  <div className="min-h-[400px] rounded-md border p-4">
                    {previewContent || watchedContent ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <pre className="whitespace-pre-wrap">{previewContent || watchedContent}</pre>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-center py-8">
                        No content to preview
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Status & Publishing */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="status">Publish Status</Label>
                <Select
                  value={watchedStatus}
                  onValueChange={(value) =>
                    setValue('status', value as PageFormData['status'])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((status) => (
                      <SelectItem key={status.value} value={status.value}>
                        <div>
                          <div>{status.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {status.description}
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="publishAt">Publish Date &amp; Time</Label>
                <Input
                  id="publishAt"
                  type="datetime-local"
                  aria-describedby="publishAt-help"
                  {...register('publishAt')}
                />
                <p id="publishAt-help" className="text-xs text-muted-foreground">
                  Leave empty to publish immediately. A future date withholds the
                  page from the public site until that moment, then it goes live on
                  its own — no redeploy needed.
                </p>
                {effectivePublishAt && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-0 text-xs"
                    onClick={() => {
                      setValue('publishAt', '');
                      setValue('scheduledFor', '');
                    }}
                  >
                    Clear scheduled publish date
                  </Button>
                )}
              </div>

              {/* Explicit statement of what the public site will do with this page
                  right now, derived from the same rules the public route uses. */}
              <div
                role="status"
                aria-live="polite"
                data-testid="publish-state"
                data-state={publishState}
                className={cn(
                  'flex items-start gap-2 rounded-md border p-3 text-sm',
                  publishState === 'published' &&
                    'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100',
                  publishState === 'scheduled' &&
                    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
                  (publishState === 'draft' || publishState === 'archived') &&
                    'border-border bg-muted/40 text-muted-foreground',
                )}
              >
                {publishState === 'published' && (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                {publishState === 'scheduled' && (
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                {publishState === 'archived' && (
                  <Archive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {publishState === 'published' && 'Live now — visible to everyone.'}
                  {publishState === 'scheduled' &&
                    effectivePublishAt &&
                    `Scheduled — goes live automatically on ${effectivePublishAt.toLocaleString()}. Not visible to the public until then.`}
                  {publishState === 'scheduled' &&
                    !effectivePublishAt &&
                    'Scheduled — set a publish date and time to choose when it goes live.'}
                  {publishState === 'draft' && 'Draft — not visible to the public.'}
                  {publishState === 'archived' && 'Archived — not visible to the public.'}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* SEO Settings */}
          <Card>
            <CardHeader>
              <CardTitle>SEO Settings</CardTitle>
              <CardDescription>
                Optimize for search engines
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="metaTitle">Meta Title</Label>
                <Input
                  id="metaTitle"
                  placeholder="Override page title for SEO..."
                  {...register('metaTitle')}
                />
                <p className="text-xs text-muted-foreground">
                  {watch('metaTitle')?.length || 0}/60 characters
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="metaDescription">Meta Description</Label>
                <Textarea
                  id="metaDescription"
                  placeholder="Description for search results..."
                  rows={3}
                  {...register('metaDescription')}
                />
                <p className="text-xs text-muted-foreground">
                  {watch('metaDescription')?.length || 0}/160 characters
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ogImage">Open Graph Image</Label>
                <Input
                  id="ogImage"
                  placeholder="https://example.com/image.jpg"
                  {...register('ogImage')}
                />
                <p className="text-xs text-muted-foreground">
                  Image for social media sharing
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardContent className="pt-6 space-y-2">
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    {isEdit ? 'Update Page' : 'Create Page'}
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handlePreview}
              >
                <Eye className="mr-2 h-4 w-4" />
                Preview
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </form>
  );
}
