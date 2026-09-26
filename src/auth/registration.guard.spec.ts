import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RegistrationGuard } from './registration.guard';

describe('RegistrationGuard', () => {
  let guard: RegistrationGuard;
  let configService: { get: Mock };

  const mockExecutionContext = () => {
    const response = { redirect: vi.fn() };
    return {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
      response,
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    configService = { get: vi.fn() };
    guard = new RegistrationGuard(configService as unknown as ConfigService);
  });

  it('allows access when DISABLE_REGISTRATION is false', () => {
    configService.get.mockReturnValue(false);
    const context = mockExecutionContext();

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when DISABLE_REGISTRATION is undefined', () => {
    configService.get.mockReturnValue(undefined);
    const context = mockExecutionContext();

    expect(guard.canActivate(context)).toBe(true);
  });

  it('redirects to /auth/login and blocks access when DISABLE_REGISTRATION is true', () => {
    configService.get.mockReturnValue(true);
    const context = mockExecutionContext();
    const response = context.switchToHttp().getResponse();

    expect(guard.canActivate(context)).toBe(false);
    expect(response.redirect).toHaveBeenCalledWith('/auth/login', 302);
  });
});
