import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let configService: { get: jest.Mock };

  const payload = { userId: 3, email: 'a@b.c', pwf: '12345678' };

  const mockExecutionContext = (request: Record<string, unknown>) => ({
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
    request,
  });

  beforeEach(() => {
    configService = { get: jest.fn() };
    guard = new AuthGuard(configService as unknown as ConfigService);
  });

  it('is a 404 when AUTH_ENABLED is false', () => {
    configService.get.mockReturnValue(false);
    const { context } = mockExecutionContext({ auth: { payload } });

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });

  it('is a 401 when no session was resolved', () => {
    configService.get.mockReturnValue(true);
    const { context } = mockExecutionContext({
      cookies: { access_token: 'x' },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('publishes the resolved payload as request.user', () => {
    configService.get.mockReturnValue(true);
    const { context, request } = mockExecutionContext({
      auth: { user: { id: 3 }, payload },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toBe(payload);
  });
});
