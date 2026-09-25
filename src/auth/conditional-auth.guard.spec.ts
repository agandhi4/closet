import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalAuthGuard } from './conditional-auth.guard';

describe('ConditionalAuthGuard', () => {
  let guard: ConditionalAuthGuard;
  let configService: { get: jest.Mock };

  const payload = { userId: 3, email: 'a@b.c', pwf: '12345678' };

  const mockExecutionContext = (request: Record<string, unknown>) => {
    const response = { redirect: jest.fn() };
    return {
      context: {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as unknown as ExecutionContext,
      request,
      response,
    };
  };

  beforeEach(() => {
    configService = { get: jest.fn() };
    guard = new ConditionalAuthGuard(configService as unknown as ConfigService);
  });

  it('passes everything through when AUTH_ENABLED is false', () => {
    configService.get.mockReturnValue(false);
    const { context, request } = mockExecutionContext({});

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('publishes the resolved payload as request.user', () => {
    configService.get.mockReturnValue(true);
    const { context, request } = mockExecutionContext({
      auth: { user: { id: 3 }, payload },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toBe(payload);
  });

  it('redirects to /auth/login when no session was resolved', () => {
    configService.get.mockReturnValue(true);
    const { context, response } = mockExecutionContext({ cookies: {} });

    expect(guard.canActivate(context)).toBe(false);
    expect(response.redirect).toHaveBeenCalledWith('/auth/login', 302);
  });
});
