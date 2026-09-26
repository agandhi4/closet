import { ArgumentsHost, NotFoundException } from '@nestjs/common';
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
import { HttpError } from './web/errors';

describe('ErrorViewFilter', () => {
  let filter: ErrorViewFilter;
  let response: {
    sent: boolean;
    locals: Record<string, unknown>;
    redirect: Mock;
    header: Mock;
    status: Mock;
    view: Mock;
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
      view: vi.fn().mockResolvedValue(undefined),
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
    expect(response.view).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers LoginRequiredException with a bodiless 401 and HX-Redirect', async () => {
    await filter.catch(new LoginRequiredException(), host());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.header).toHaveBeenCalledWith('HX-Redirect', '/auth/login');
    expect(response.send).toHaveBeenCalledWith();
    expect(response.view).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders the error view for other HttpExceptions and logs at warn', async () => {
    const exception = new NotFoundException();
    await filter.catch(exception, host());

    expect(warn).toHaveBeenCalledWith(exception);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.view).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        statusCode: 404,
        path: '/wardrobe',
        appName: 'Closet',
      }),
    );
  });

  // Plain modules (src/web/files) throw the web layer's HttpError into the
  // Nest services that still call them.
  it("renders the web layer's HttpError with its status and message", async () => {
    await filter.catch(new HttpError(400, 'Unreadable image'), host());

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.view).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ statusCode: 400, message: 'Unreadable image' }),
    );
  });

  it('answers anything else with a 500 without detail', async () => {
    await filter.catch(new Error('connection refused at 10.0.0.5'), host());

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.view).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        statusCode: 500,
        message: 'Internal server error',
      }),
    );
  });

  it('skips rendering when the reply is already sent', async () => {
    response.sent = true;
    await filter.catch(new Error('boom'), host());

    expect(response.status).not.toHaveBeenCalled();
    expect(response.view).not.toHaveBeenCalled();
  });
});
