import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AuthContextService } from './auth-context.service';

describe('AuthContextService', () => {
  let service: AuthContextService;
  let jwtService: { verifyAsync: Mock };
  let userRepository: { findOne: Mock };

  const hash = '$2a$12$abcdefghijklmnopqrstuvwxyzFINGERPR';
  const user = { id: 7, email: 'a@b.c', password: hash };
  const payload = { userId: 7, email: 'a@b.c', pwf: hash.slice(-8) };

  const request = (cookies?: Record<string, string>) =>
    ({ cookies }) as unknown as FastifyRequest;

  beforeEach(() => {
    jwtService = { verifyAsync: vi.fn() };
    userRepository = { findOne: vi.fn() };
    service = new AuthContextService(
      userRepository as any,
      jwtService as unknown as JwtService,
    );
  });

  it('returns undefined without a cookie', async () => {
    await expect(service.resolve(request())).resolves.toBeUndefined();
    await expect(service.resolve(request({}))).resolves.toBeUndefined();
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('returns undefined for a token that fails verification', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt malformed'));

    await expect(
      service.resolve(request({ access_token: 'bad' })),
    ).resolves.toBeUndefined();
    expect(userRepository.findOne).not.toHaveBeenCalled();
  });

  it('returns undefined when the user no longer exists', async () => {
    jwtService.verifyAsync.mockResolvedValue(payload);
    userRepository.findOne.mockResolvedValue(null);

    await expect(
      service.resolve(request({ access_token: 'ok' })),
    ).resolves.toBeUndefined();
  });

  it('returns undefined on a password fingerprint mismatch', async () => {
    jwtService.verifyAsync.mockResolvedValue({ ...payload, pwf: 'stale123' });
    userRepository.findOne.mockResolvedValue(user);

    await expect(
      service.resolve(request({ access_token: 'ok' })),
    ).resolves.toBeUndefined();
  });

  it('resolves user and payload with exactly one verification and one user load', async () => {
    jwtService.verifyAsync.mockResolvedValue(payload);
    userRepository.findOne.mockResolvedValue(user);

    await expect(
      service.resolve(request({ access_token: 'ok' })),
    ).resolves.toEqual({ user, payload });
    expect(jwtService.verifyAsync).toHaveBeenCalledTimes(1);
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('ok');
    expect(userRepository.findOne).toHaveBeenCalledTimes(1);
    expect(userRepository.findOne).toHaveBeenCalledWith({ id: 7 });
  });
});
