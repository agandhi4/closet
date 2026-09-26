import { ArgumentsHost, NotFoundException } from '@nestjs/common';
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
    redirect: jest.Mock;
    header: jest.Mock;
    status: jest.Mock;
    view: jest.Mock;
    send: jest.Mock;
  };
  let warn: jest.SpyInstance;

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
      redirect: jest.fn(),
      header: jest.fn(),
      status: jest.fn(),
      view: jest.fn().mockResolvedValue(undefined),
      send: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.redirect.mockReturnValue(response);
    response.header.mockReturnValue(response);
    warn = jest.spyOn(filter['logger'], 'warn').mockImplementation(() => {});
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

  it('skips rendering when the reply is already sent', async () => {
    response.sent = true;
    await filter.catch(new Error('boom'), host());

    expect(response.status).not.toHaveBeenCalled();
    expect(response.view).not.toHaveBeenCalled();
  });
});
