import { SharePermission } from '../dal/entity/wardrobe-share.entity';
import { WardrobeShareService } from './wardrobe-share.service';

describe('WardrobeShareService.resolveAccess', () => {
  let service: WardrobeShareService;
  let shareRepository: { findOne: jest.Mock };

  beforeEach(() => {
    shareRepository = { findOne: jest.fn() };
    service = new WardrobeShareService(shareRepository as any, {} as any);
  });

  it('grants everything on own wardrobe without a share lookup', async () => {
    await expect(service.resolveAccess(5, undefined)).resolves.toEqual({
      ownerId: 5,
      isOwner: true,
      canView: true,
      canManage: true,
    });
    await expect(service.resolveAccess(5, 5)).resolves.toEqual({
      ownerId: 5,
      isOwner: true,
      canView: true,
      canManage: true,
    });
    expect(shareRepository.findOne).not.toHaveBeenCalled();
  });

  it('derives view-only access from a VIEW share', async () => {
    shareRepository.findOne.mockResolvedValue({
      permission: SharePermission.VIEW,
    });

    await expect(service.resolveAccess(5, 9)).resolves.toEqual({
      ownerId: 9,
      isOwner: false,
      canView: true,
      canManage: false,
      permission: SharePermission.VIEW,
    });
    expect(shareRepository.findOne).toHaveBeenCalledTimes(1);
    expect(shareRepository.findOne).toHaveBeenCalledWith({
      grantor: { id: 9 },
      grantee: { id: 5 },
      acceptedAt: { $ne: null },
    });
  });

  it('derives manage access from a MANAGE share', async () => {
    shareRepository.findOne.mockResolvedValue({
      permission: SharePermission.MANAGE,
    });

    await expect(service.resolveAccess(5, 9)).resolves.toEqual({
      ownerId: 9,
      isOwner: false,
      canView: true,
      canManage: true,
      permission: SharePermission.MANAGE,
    });
  });

  it('denies both when no accepted share exists', async () => {
    shareRepository.findOne.mockResolvedValue(null);

    await expect(service.resolveAccess(5, 9)).resolves.toEqual({
      ownerId: 9,
      isOwner: false,
      canView: false,
      canManage: false,
      permission: undefined,
    });
  });
});
