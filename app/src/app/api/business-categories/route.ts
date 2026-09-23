import { NextResponse } from 'next/server';
import { listBusinessCategories } from '@/features/business-directory/read';
import { internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

export async function GET() {
  try {
    return NextResponse.json(await listBusinessCategories(getPrisma()));
  } catch (error) {
    return internalError(error);
  }
}
