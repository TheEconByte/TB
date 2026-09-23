import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn(), resolveBusinessProfile: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));
vi.mock('@/features/business-profile/resolve', () => ({ resolveBusinessProfile: mocks.resolveBusinessProfile }));

import { PUT } from '@/app/api/plans/[planId]/business-profile/route';

const profile = {
  districtCode: '11440',
  marketIndustryCode: 'CS100001',
  detailedIndustryCode: null,
  area: { value: '24', unit: 'PYEONG' },
  floor: 'GROUND_1',
  buildingType: 'SMALL_RETAIL',
} as const;
const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const request = (revision = 1) =>
  new Request('http://localhost/api/plans/plan-a/business-profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessProfile: profile, revision }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a' });
  mocks.resolveBusinessProfile.mockResolvedValue({
    kind: 'OK',
    profile: {
      schemaVersion: 'business-profile-v1.0.0',
      ...profile,
      districtName: '마포구',
      marketIndustryName: '한식',
      detailedIndustryName: null,
      provenance: { marketReleaseKey: 'market-a', businessDirectoryReleaseKey: null },
    },
  });
});

describe('사업 조건 저장 경계', () => {
  it('미로그인 사용자를 차단한다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    expect((await PUT(request(), context)).status).toBe(401);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('소유자와 revision이 일치할 때만 별도 JSON을 저장한다', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.getPrisma.mockReturnValue({
      plan: { updateMany, findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'plan-a', revision: 2 }) },
    });
    expect((await PUT(request(), context)).status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'plan-a', userId: 'user-a', revision: 1 },
        data: expect.objectContaining({ revision: { increment: 1 } }),
      }),
    );
  });

  it('다른 사용자 계획은 404, 오래된 revision은 409로 구분한다', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 3 });
    mocks.getPrisma.mockReturnValue({ plan: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findFirst } });
    expect((await PUT(request(), context)).status).toBe(404);
    expect((await PUT(request(), context)).status).toBe(409);
  });
});
