'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Plus,
  Trash2,
  Eye,
  Save,
  Loader2,
  Code,
  FileText,
} from 'lucide-react';
import { EmailTemplateType, EmailTemplate } from '@prisma/client';
import { extractTemplateVariables } from '@/lib/email-template-utils';
import { SafeHtml } from '@/components/ui/safe-html';
import { sanitizeHtml } from '@/lib/safe-html';

const templateTypes = [
  { value: 'WELCOME', label: 'Welcome Email' },
  { value: 'PASSWORD_RESET', label: 'Password Reset' },
  { value: 'EVENT_REMINDER', label: 'Event Reminder' },
  { value: 'ANNOUNCEMENT', label: 'Announcement' },
  { value: 'ATTENDANCE_SUMMARY', label: 'Attendance Summary' },
  { value: 'CUSTOM', label: 'Custom Template' },
];

const templateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: z.enum(['WELCOME', 'PASSWORD_RESET', 'EVENT_REMINDER', 'ANNOUNCEMENT', 'ATTENDANCE_SUMMARY', 'CUSTOM']),
  subject: z.string().min(1, 'Subject is required').max(200),
  body: z.string().min(1, 'Body is required'),
  textBody: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
});

type TemplateFormData = z.infer<typeof templateSchema>;

interface Variable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

interface EmailTemplateFormProps {
  template?: EmailTemplate | null;
  onSubmit: (data: TemplateFormData & { variables: Variable[] }) => Promise<void>;
  isSubmitting?: boolean;
}

export function EmailTemplateForm({ template, onSubmit, isSubmitting }: EmailTemplateFormProps) {
  const router = useRouter();
  const [variables, setVariables] = useState<Variable[]>(
    (template?.variables as unknown as Variable[]) || []
  );
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewVars, setPreviewVars] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState('edit');
  const [detectedVars, setDetectedVars] = useState<string[]>([]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TemplateFormData>({
    resolver: zodResolver(templateSchema),
    defaultValues: {
      name: template?.name || '',
      type: (template?.type as EmailTemplateType) || 'CUSTOM',
      subject: template?.subject || '',
      body: template?.body || '',
      textBody: template?.textBody || '',
      description: template?.description || '',
      isActive: template?.isActive ?? true,
      isDefault: template?.isDefault ?? false,
    },
  });

  const watchedBody = watch('body');
  const watchedSubject = watch('subject');
  const watchedTextBody = watch('textBody');
  const watchedType = watch('type');
  const watchedIsActive = watch('isActive');
  const watchedIsDefault = watch('isDefault');

  // Detect variables from template content
  useEffect(() => {
    const allContent = `${watchedSubject} ${watchedBody} ${watchedTextBody || ''}`;
    const detected = extractTemplateVariables(allContent);
    setDetectedVars(detected);

    // Auto-add detected variables that aren't already in the list
    const newVars = detected
      .filter((v) => !variables.some((existing) => existing.name === v))
      .map((v) => ({
        name: v,
        description: '',
        required: true,
      }));

    if (newVars.length > 0) {
      setVariables((prev) => [...prev, ...newVars]);
    }
  }, [watchedSubject, watchedBody, watchedTextBody, variables]);

  // Generate preview
  useEffect(() => {
    let html = watchedBody;
    let subject = watchedSubject;
    let text = watchedTextBody || '';

    // Replace variables in preview
    Object.entries(previewVars).forEach(([key, value]) => {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      html = html.replace(regex, value);
      subject = subject.replace(regex, value);
      text = text.replace(regex, value);
    });

    // Sanitize HTML
    setPreviewHtml(html);
    setPreviewSubject(subject);
    setPreviewText(text);
  }, [watchedBody, watchedSubject, watchedTextBody, previewVars]);

  const handleFormSubmit = (data: TemplateFormData) => {
    onSubmit({ ...data, variables });
  };

  const addVariable = () => {
    setVariables([...variables, { name: '', description: '', required: false }]);
  };

  const removeVariable = (index: number) => {
    const newVars = [...variables];
    newVars.splice(index, 1);
    setVariables(newVars);
  };

  const updateVariable = (index: number, field: keyof Variable, value: string | boolean) => {
    const newVars = [...variables];
     
    (newVars[index] as any)[field] = value; // nosemgrep: safe-access
    setVariables(newVars);
  };

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {template ? 'Edit Email Template' : 'New Email Template'}
          </h1>
          <p className="text-muted-foreground">
            {template
              ? 'Update existing email template configuration'
              : 'Create a new email template for system notifications'}
          </p>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Left Column - Configuration */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template Settings</CardTitle>
              <CardDescription>Basic configuration for this template</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Template Name</Label>
                <Input
                  id="name"
                  {...register('name')}
                  placeholder="e.g., Welcome Email"
                />
                {errors.name && (
                  <p className="text-sm text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  {...register('description')}
                  placeholder="Internal description of when this email is sent"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="type">Template Type</Label>
                <Select
                  value={watchedType}
                  onValueChange={(value) => setValue('type', value as EmailTemplateType)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {templateTypes.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="isActive"
                    checked={watchedIsActive}
                    onCheckedChange={(checked) => setValue('isActive', checked)}
                  />
                  <Label htmlFor="isActive">Active</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="isDefault"
                    checked={watchedIsDefault}
                    onCheckedChange={(checked) => setValue('isDefault', checked)}
                  />
                  <Label htmlFor="isDefault">Default for Type</Label>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Email Content</CardTitle>
              <CardDescription>
                Use <code className="bg-muted px-1 rounded text-sm">{'{{variable}}'}</code> for dynamic content.
                Use <code className="bg-muted px-1 rounded text-sm">{'{{#if var}}'}...{'{{/if}}'}</code> for conditionals.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="subject">Subject Line</Label>
                <Input
                  id="subject"
                  {...register('subject')}
                  placeholder="e.g., Welcome to {{organizationName}}!"
                />
                {errors.subject && (
                  <p className="text-sm text-destructive">{errors.subject.message}</p>
                )}
              </div>

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="edit">
                    <Code className="mr-2 h-4 w-4" />
                    HTML Body
                  </TabsTrigger>
                  <TabsTrigger value="text">
                    <FileText className="mr-2 h-4 w-4" />
                    Plain Text
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="edit" className="mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="body">HTML Body</Label>
                    <Textarea
                      id="body"
                      {...register('body')}
                      placeholder="<p>Hello {{firstName}},</p>"
                      className="min-h-[300px] font-mono text-sm"
                    />
                    {errors.body && (
                      <p className="text-sm text-destructive">{errors.body.message}</p>
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="text" className="mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="textBody">Plain Text Version (Optional)</Label>
                    <Textarea
                      id="textBody"
                      {...register('textBody')}
                      placeholder="Hello {{firstName}},"
                      className="min-h-[300px] font-mono text-sm"
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Variables</CardTitle>
                  <CardDescription>
                    Define the variables used in this template
                  </CardDescription>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addVariable}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Variable
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {detectedVars.length > 0 && (
                <div className="mb-4">
                  <p className="text-sm text-muted-foreground mb-2">
                    Detected variables:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {detectedVars.map((v) => (
                      <Badge key={v} variant="secondary">
                        {v}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {variables.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No variables defined. Variables will be auto-detected from the template content.
                </p>
              ) : (
                <div className="space-y-4">
                  {variables.map((variable, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <div className="grid flex-1 gap-2 sm:grid-cols-3">
                        <Input
                          placeholder="Variable name"
                          value={variable.name}
                          onChange={(e) => updateVariable(index, 'name', e.target.value)}
                          className="font-mono"
                        />
                        <Input
                          placeholder="Description"
                          value={variable.description}
                          onChange={(e) => updateVariable(index, 'description', e.target.value)}
                        />
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={variable.required}
                            onCheckedChange={(checked) => updateVariable(index, 'required', checked)}
                          />
                          <span className="text-sm">Required</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeVariable(index)}
                            className="ml-auto"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Preview */}
        <div className="space-y-6">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Preview
              </CardTitle>
              <CardDescription>
                Test your template with sample data
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Preview Variables</Label>
                <ScrollArea className="h-[200px] rounded-md border p-4">
                  <div className="space-y-2">
                    {detectedVars.map((varName) => (
                      <div key={varName} className="flex items-center gap-2">
                        <Label htmlFor={`preview-${varName}`} className="w-32 text-sm font-mono">{varName}</Label>
                        <Input
                          id={`preview-${varName}`}
                          name={`preview-${varName}`}
                          value={previewVars[varName] || ''}
                          onChange={(e) =>
                            setPreviewVars((prev) => ({
                              ...prev,
                              [varName]: e.target.value,
                            }))
                          }
                          placeholder={`Enter ${varName}`}
                          className="flex-1"
                        />
                      </div>
                    ))}
                    {detectedVars.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        Add variables to your template to see them here.
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-sm font-medium">Subject Preview</Label>
                <div className="rounded-md border p-3 bg-muted/50">
                  <p className="text-sm">{previewSubject || 'No subject'}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">HTML Preview</Label>
                <ScrollArea className="h-[300px] rounded-md border">
                  <SafeHtml
                    className="p-4 prose prose-sm max-w-none"
                    html={previewHtml}
                  />
                </ScrollArea>
              </div>
              {previewText && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Plain Text Preview</Label>
                  <ScrollArea className="h-[150px] rounded-md border p-3 bg-muted/50">
                    <pre className="text-sm whitespace-pre-wrap font-sans">
                      {previewText}
                    </pre>
                  </ScrollArea>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex justify-end gap-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Save Template
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
