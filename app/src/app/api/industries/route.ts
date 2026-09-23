import { NextResponse } from 'next/server';
import { listSupportedIndustries } from '@/features/market/read';
import { MARKET_LIMITATIONS } from '@/features/market/types';
import { internalError } from '@/lib/api';
import { getPrisma } from '@/lib/prisma';

// Public endpoint: commercial-area exploration does not require a session.
export async function GET() {
  try {
    const { activeRelease, industries } = await listSupportedIndustries(getPrisma());
    return NextResponse.json({ activeRelease, industries, limitations: MARKET_LIMITATIONS });
  } catch (error) {
    return internalError(error);
  }
}
