import { ArgumentsHost } from '@nestjs/common';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './auth/redirect-to-login.exception';
import { ErrorViewFilter } from './error-view.filter';

describe('ErrorViewFilter', () => {
  let filter: ErrorViewFilter;
  let response: {
    sent: boolean;
    locals: Record<string, unknown>;
    redirect: Mock;
    header: Mock;
    status: Mock;
    send: Mock;
  };
  let warn: MockInstance;

  const host = () =>
    ({
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/wardrobe' }),
      }),
    }) as unknown as ArgumentsHost;

  beforeEach(() => {
    filter = new ErrorViewFilter();
    response = {
      sent: false,
      locals: { appName: 'Closet' },
      redirect: vi.fn(),
      header: vi.fn(),
      status: vi.fn(),
      send: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.redirect.mockReturnValue(response);
    response.header.mockReturnValue(response);
    warn = vi.spyOn(filter['logger'], 'warn').mockImplementation(() => {});
  });

  it('answers RedirectToLoginException with the 302 and no warn log', async () => {
    await filter.catch(new RedirectToLoginException(), host());

    expect(response.redirect).toHaveBeenCalledWith('/auth/login', 302);
    expect(response.send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers LoginRequiredException with a bodiless 401 and HX-Redirect', async () => {
    await filter.catch(new LoginRequiredException(), host());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.header).toHaveBeenCalledWith('HX-Redirect', '/auth/login');
    expect(response.send).toHaveBeenCalledWith();
    expect(warn).not.toHaveBeenCalled();
  });
});
