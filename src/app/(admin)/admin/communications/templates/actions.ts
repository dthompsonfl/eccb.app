'use server';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { EmailTemplateType } from '@prisma/client';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  initializeDefaultTemplates,
  renderTemplate,
  validateTemplateVariables,
  CreateTemplateData,
  UpdateTemplateData,
} from '@/lib/services/email-template.service';
import { TemplateVariable } from '@/lib/email-template-utils';

// ====================================
// Validation Schemas
// ====================================

const templateVariableSchema = z.object({
  name: z.string().min(1, 'Variable name is required'),
  description: z.string().optional(),
  required: z.boolean().default(true),
  defaultValue: z.string().optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(100),
  type: z.enum(['WELCOME', 'PASSWORD_RESET', 'EVENT_REMINDER', 'ANNOUNCEMENT', 'ATTENDANCE_SUMMARY', 'CUSTOM']),
  subject: z.string().min(1, 'Subject is required').max(200),
  body: z.string().min(1, 'Email body is required'),
  textBody: z.string().optional(),
  description: z.string().optional(),
  variables: z.array(templateVariableSchema).optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const updateTemplateSchema = createTemplateSchema.partial();

const previewTemplateSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Email body is required'),
  textBody: z.string().optional(),
  variables: z.record(z.string(), z.unknown()),
});

// ====================================
// Server Actions
// ====================================

export async function getTemplatesAction(options?: {
  type?: EmailTemplateType;
  isActive?: boolean;
}) {
  await requirePermission(MESSAGE_SEND_ALL);
  return getTemplates(options);
}

export async function getTemplateByIdAction(id: string) {
  await requirePermission(MESSAGE_SEND_ALL);
  return getTemplateById(id);
}

export async function createTemplateAction(data: CreateTemplateData) {
  const session = await requirePermission(MESSAGE_SEND_ALL);

  try {
    const validated = createTemplateSchema.parse(data);
    
    const template = await createTemplate({
      ...validated,
      createdBy: session.user.id,
    });

    await auditLog({
      action: 'CREATE_EMAIL_TEMPLATE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: template.id,
      newValues: {
        name: template.name,
        type: template.type,
      },
    });

    revalidatePath('/admin/communications/templates');
    
    return { success: true, template };
  } catch (error) {
    console.error('Error creating email template:', error);
    if (error instanceof z.ZodError) {
      return { success: false, error: 'Validation failed', details: error.issues };
    }
    return { success: false, error: 'Failed to create template' };
  }
}

export async function updateTemplateAction(id: string, data: UpdateTemplateData) {
  await requirePermission(MESSAGE_SEND_ALL);

  try {
    const validated = updateTemplateSchema.parse(data);
    
    const template = await updateTemplate(id, validated);

    await auditLog({
      action: 'UPDATE_EMAIL_TEMPLATE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: template.id,
      newValues: {
        name: template.name,
        type: template.type,
      },
    });

    revalidatePath('/admin/communications/templates');
    revalidatePath(`/admin/communications/templates/${id}`);
    
    return { success: true, template };
  } catch (error) {
    console.error('Error updating email template:', error);
    if (error instanceof z.ZodError) {
      return { success: false, error: 'Validation failed', details: error.issues };
    }
    return { success: false, error: 'Failed to update template' };
  }
}

export async function deleteTemplateAction(id: string) {
  await requirePermission(MESSAGE_SEND_ALL);

  try {
    const template = await getTemplateById(id);
    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    // Prevent deleting default templates
    if (template.isDefault) {
      return { success: false, error: 'Cannot delete default templates' };
    }

    await deleteTemplate(id);

    await auditLog({
      action: 'DELETE_EMAIL_TEMPLATE',
      entityType: 'EMAIL_TEMPLATE',
      entityId: id,
      oldValues: {
        name: template.name,
        type: template.type,
      },
    });

    revalidatePath('/admin/communications/templates');
    
    return { success: true };
  } catch (error) {
    console.error('Error deleting email template:', error);
    return { success: false, error: 'Failed to delete template' };
  }
}

export async function initializeDefaultTemplatesAction(): Promise<void> {
  await requirePermission(MESSAGE_SEND_ALL);

  try {
    const result = await initializeDefaultTemplates();
    
    await auditLog({
      action: 'INITIALIZE_DEFAULT_TEMPLATES',
      entityType: 'EMAIL_TEMPLATE',
      entityId: 'batch',
      newValues: result,
    });

    revalidatePath('/admin/communications/templates');
  } catch (error) {
    console.error('Error initializing default templates:', error);
  }
}

export async function previewTemplateAction(data: {
  subject: string;
  body: string;
  textBody?: string;
  variables: Record<string, unknown>;
}) {
  await requirePermission(MESSAGE_SEND_ALL);

  try {
    const validated = previewTemplateSchema.parse(data);
    
    // Create a temporary template object for preview
    const previewTemplate = {
      id: 'preview',
      name: 'Preview',
      type: 'CUSTOM' as EmailTemplateType,
      subject: validated.subject,
      body: validated.body,
      textBody: validated.textBody ?? null,
      description: null,
      variables: [],
      isActive: true,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
    };

    const rendered = await renderTemplate(
      { ...previewTemplate, variables: previewTemplate.variables as unknown as string },
      validated.variables as Record<string, string>
    );
    
    return { success: true, rendered };
  } catch (error) {
    console.error('Error previewing template:', error);
    if (error instanceof z.ZodError) {
      return { success: false, error: 'Validation failed', details: error.issues };
    }
    return { success: false, error: 'Failed to preview template' };
  }
}

export async function validateVariablesAction(
  templateId: string,
  variables: Record<string, unknown>
) {
  await requirePermission(MESSAGE_SEND_ALL);

  try {
    const template = await getTemplateById(templateId);
    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    // Parse variables from Json to TemplateVariable[]
    const templateVariables = template.variables as TemplateVariable[] | null;
    const result = validateTemplateVariables(templateVariables, variables);
    
    return { success: true, ...result };
  } catch (error) {
    console.error('Error validating variables:', error);
    return { success: false, error: 'Failed to validate variables' };
  }
}
