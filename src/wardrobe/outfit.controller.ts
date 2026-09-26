import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Render,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { UserId } from '../auth/user.decorator';
import { OutfitService } from './outfit.service';
import { GarmentService } from './garment.service';
import { safeReturnTo } from '../web/security/return-to';

@Controller('outfits')
export class OutfitController {
  private readonly logger = new Logger(OutfitController.name);

  constructor(
    private readonly outfitService: OutfitService,
    private readonly garmentService: GarmentService,
  ) {}

  @Get()
  @Render('outfits/index')
  async index(@UserId() userId: number) {
    const outfits = await this.outfitService.findAll(userId);
    return { outfits };
  }

  @Get('new')
  @Render('outfits/form')
  async newForm(
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('scheduleDate') scheduleDate?: string,
    @Query('returnTo') returnTo?: string,
  ) {
    const garments = await this.garmentService.findAll(userId);
    const categoryRows = this.outfitService.buildCategoryRows(
      garments,
      [],
      i18n,
    );
    return {
      outfit: null,
      scheduleDate: scheduleDate || null,
      // Rendered as the Back/Cancel link: same-site paths only.
      returnTo: safeReturnTo(returnTo, '/outfits'),
      categoryRows,
      allCategoryRows: categoryRows,
    };
  }

  @Post()
  async create(
    @Body()
    body: {
      name?: string;
      notes?: string;
      scheduleDate?: string;
      category?: string | string[];
      garmentId?: string | string[];
      returnTo?: string;
      returnToWeek?: string;
    },
    @UserId() userId: number,
    @Res() reply: FastifyReply,
  ) {
    const slots = this.outfitService.parseSlotsFromBody(
      body.category,
      body.garmentId,
    );

    const outfit = await this.outfitService.create(
      { name: body.name, notes: body.notes, slots },
      userId,
    );
    if (body.scheduleDate) {
      await this.outfitService.schedule(outfit.id, body.scheduleDate, userId);
    }
    if (body.returnTo === '/calendar') {
      const week = body.returnToWeek ?? body.scheduleDate;
      return reply.redirect(week ? `/calendar?week=${week}` : '/calendar', 302);
    }
    return reply.redirect(`/outfits/${outfit.id}`, 302);
  }

  @Get('row-fragment')
  async rowFragment(
    @Query('category') category: string,
    @Query('index') indexStr: string,
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @I18n() i18n: I18nContext,
  ) {
    if (!category?.trim()) return reply.status(400).send();
    const items = await this.garmentService.findAll(userId, {
      category,
    });
    const count = items.length;
    const rawIdx =
      indexStr !== undefined && indexStr !== '' ? parseInt(indexStr) : 1;
    const idx = Math.min(Math.max(isNaN(rawIdx) ? 1 : rawIdx, 0), count);
    const row = this.outfitService.buildRow(category, items, idx, i18n);
    return reply.viewPartial('partials/outfit_row', { row });
  }

  @Get(':id')
  @Render('outfits/show')
  async show(@Param('id', ParseIntPipe) id: number, @UserId() userId: number) {
    const outfit = await this.outfitService.findOne(id, userId);
    const garments = outfit.garments.getItems();
    return { outfit, garments };
  }

  @Get(':id/edit')
  @Render('outfits/form')
  async editForm(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('returnTo') returnTo?: string,
    @Query('returnToWeek') returnToWeek?: string,
  ) {
    const [outfit, garments] = await Promise.all([
      this.outfitService.findOne(id, userId),
      this.garmentService.findAll(userId),
    ]);
    const selectedGarmentIds = outfit.garments.getItems().map((g) => g.id);
    return {
      outfit,
      returnTo: safeReturnTo(returnTo, `/outfits/${id}`),
      returnToWeek: returnToWeek || null,
      categoryRows: this.outfitService.buildCategoryRows(
        garments,
        selectedGarmentIds,
        i18n,
        outfit.slots,
      ),
      allCategoryRows: this.outfitService.buildCategoryRows(garments, [], i18n),
    };
  }

  @Post(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      notes?: string;
      scheduleDate?: string;
      category?: string | string[];
      garmentId?: string | string[];
      returnTo?: string;
      returnToWeek?: string;
    },
    @UserId() userId: number,
    @Res() reply: FastifyReply,
  ) {
    const slots = this.outfitService.parseSlotsFromBody(
      body.category,
      body.garmentId,
    );

    await this.outfitService.update(
      id,
      { name: body.name, notes: body.notes, slots },
      userId,
    );
    if (body.scheduleDate) {
      await this.outfitService.schedule(id, body.scheduleDate, userId);
    }
    if (body.returnTo === '/calendar') {
      const week = body.returnToWeek ?? body.scheduleDate;
      return reply.redirect(week ? `/calendar?week=${week}` : '/calendar', 302);
    }
    return reply.redirect(`/outfits/${id}`, 302);
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @Res() reply: FastifyReply,
  ) {
    await this.outfitService.remove(id, userId);
    reply.header('HX-Redirect', '/outfits');
    return reply.send();
  }
}
