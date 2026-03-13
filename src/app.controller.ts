import { Controller, Get, Render, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { I18n, I18nContext } from 'nestjs-i18n';

@Controller()
export class AppController {
  @Get()
  @Render('index')
  index(@I18n() i18n: I18nContext) {
    return { pageTitle: i18n.t('lang.PAGE_TITLE_HOME') };
  }

  @Get('offline.html')
  @Render('offline')
  getOffline() {}

  @Get('.well-known/*path')
  well_known() {
    return {};
  }

  @Get('sitemap.xml')
  sitemap(@Req() req: Request, @Res() res: Response): void {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`,
    );
  }
}
