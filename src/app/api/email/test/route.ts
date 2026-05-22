import { NextResponse } from 'next/server';
import { verifyEmailConnection } from '@/lib/email';
import { requirePermission } from '@/lib/auth/guards';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
export async function POST() {
  try {
    // Check authentication and permission
    await requirePermission(SYSTEM_CONFIG);

    const isConnected = await verifyEmailConnection();

    if (isConnected) {
      return NextResponse.json({
        success: true,
        message: 'Email connection verified successfully',
      });
    } else {
      return NextResponse.json({
        success: false,
        error: 'SMTP is not configured or connection failed. Emails will be written to local outbox in development.',
      });
    }
  } catch (error) {
    console.error('Error testing email connection:', error);

    if (error instanceof Error && error.message.includes('Permission denied')) {
      return NextResponse.json(
        { success: false, error: 'Permission denied' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to test email connection' },
      { status: 500 }
    );
  }
}
