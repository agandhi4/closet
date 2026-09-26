import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Render,
  Req,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import { I18n, I18nContext } from 'nestjs-i18n';
import { UserId } from '../auth/user.decorator';
import { GarmentCategory } from './garment-category.enum';
import { GarmentColor } from './garment-color.enum';
import { GarmentService } from './garment.service';
import {
  WardrobeAccess,
  WardrobeShareService,
} from '../wardrobe-share/wardrobe-share.service';
import { SearchGarmentDto } from './dto/search-garment.dto';
import { FRAGMENT_VARY, isFragmentRequest } from '../htmx/fragment-request';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface RequestAccess {
  /** Wardrobe named by `?ownerId=`; undefined for the requester's own. */
  viewOwner: number | undefined;
  access: WardrobeAccess;
}

@Controller('wardrobe')
export class WardrobeController {
  private readonly logger = new Logger(WardrobeController.name);

  constructor(
    private readonly garmentService: GarmentService,
    private readonly shareService: WardrobeShareService,
  ) {}

  private parseOwnerId(ownerId: string | undefined): number | undefined {
    return ownerId ? parseInt(ownerId, 10) : undefined;
  }

  private async resolveAccess(
    userId: number,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const viewOwner = this.parseOwnerId(ownerId);
    const access = await this.shareService.resolveAccess(userId, viewOwner);
    return { viewOwner, access };
  }

  private async requireView(
    userId: number,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const resolved = await this.resolveAccess(userId, ownerId);
    if (!resolved.access.canView) throw new ForbiddenException();
    return resolved;
  }

  private async requireManage(
    userId: number,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const resolved = await this.resolveAccess(userId, ownerId);
    if (!resolved.access.canManage) throw new ForbiddenException();
    return resolved;
  }

  // Full page for navigations; only partials/wardrobe_main for htmx fragment
  // requests (filter pills and the search form target #wardrobe-main), so a
  // search never re-renders navbar and dock. Boosted links and history
  // restores still get the page: see isFragmentRequest.
  @Get()
  async index(
    @UserId() userId: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    // 400 on an unknown colour: only enum names may reach the LIKE filter.
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: SearchGarmentDto,
    @Query('ownerId') ownerId: string | undefined,
    @I18n() i18n: I18nContext,
  ) {
    const { access } = await this.requireView(userId, ownerId);
    // A share to yourself cannot exist, so `?ownerId=<self>` is the own
    // wardrobe and the view must not render it as a shared one.
    const viewOwner = access.isOwner ? undefined : access.ownerId;

    const sharedWardrobes = (
      await this.shareService.getInboundShares(userId)
    ).map((s) => ({
      id: s.id,
      grantorId: s.grantor.unwrap().id,
      grantorName: s.grantor.unwrap().firstName || s.grantor.unwrap().email,
      permission: s.permission,
    }));

    const [garments, filters] = await Promise.all([
      this.garmentService.findAll(userId, query, viewOwner),
      this.garmentService.findAvailableFilters(access.ownerId),
    ]);
    const availableCategories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    const context = {
      garments,
      availableCategories,
      colors: Object.values(GarmentColor),
      availableSizes: filters.sizes,
      search: query,
      sharedWardrobes,
      viewOwner: viewOwner ?? null,
      canEdit: access.canManage,
    };
    reply.header('Vary', FRAGMENT_VARY);
    if (isFragmentRequest(req.headers)) {
      this.logger.debug(
        `wardrobe fragment for user ${userId}: ${garments.length} garments`,
      );
      return reply.viewPartial('partials/wardrobe_main', context);
    }
    return reply.view('wardrobe/index', context);
  }

  @Get('new')
  @Render('wardrobe/form')
  async newForm(
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(userId, ownerId);
    const filters = await this.garmentService.findAvailableFilters(
      access.ownerId,
    );
    const enumValues = Object.values(GarmentCategory) as string[];
    const customCategories = filters.categories.filter(
      (c) => !enumValues.includes(c),
    );
    const categories = [...enumValues, ...customCategories].map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    return {
      categories,
      colors: Object.values(GarmentColor),
      garment: null,
      viewOwner,
    };
  }

  @Post()
  async create(
    @Body()
    body: {
      name?: string;
      category: string;
      brand?: string;
      color?: string | string[];
      size?: string;
      notes?: string;
      washingDetails?: string;
      dateAquired?: string;
    },
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(userId, ownerId);

    // Fastify gives string if one checkbox, string[] if multiple — normalise both
    const rawColors = Array.isArray(body.color)
      ? body.color
      : (body.color
          ?.split(',')
          .map((c) => c.trim())
          .filter(Boolean) ?? []);

    const garment = await this.garmentService.create(
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: rawColors.join(','),
        size: body.size,
        notes: body.notes,
        washingDetails: body.washingDetails,
        dateAquired: body.dateAquired,
      },
      access.ownerId,
    );

    const params = new URLSearchParams({ created: '1' });
    if (viewOwner) params.set('ownerId', String(viewOwner));
    return reply.redirect(`/wardrobe/${garment.id}?${params}`, 302);
  }

  @Get(':id')
  @Render('wardrobe/show')
  async show(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
    @Query('created') created: string | undefined,
    @Query('photoSaved') photoSaved: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireView(userId, ownerId);
    const garment = await this.garmentService.findOne(id, userId, viewOwner);

    return {
      garment,
      categoryLabel: this.garmentService.resolveCategoryLabel(
        garment.category,
        i18n,
      ),
      canEdit: access.canManage,
      canDelete: access.isOwner,
      canClone: access.canManage,
      viewOwner: viewOwner ?? null,
      justCreated: created === '1',
      justSavedPhoto: photoSaved === '1',
    };
  }

  @Get(':id/edit')
  @Render('wardrobe/form')
  async editForm(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(userId, ownerId);

    const [garment, filters] = await Promise.all([
      this.garmentService.findOne(id, userId, viewOwner),
      this.garmentService.findAvailableFilters(access.ownerId),
    ]);
    const enumValues = Object.values(GarmentCategory) as string[];
    const customCategories = filters.categories.filter(
      (c) => !enumValues.includes(c),
    );
    const categories = [...enumValues, ...customCategories].map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    const colorEnumValues = Object.values(GarmentColor) as string[];
    const savedColors =
      garment.color
        ?.split(',')
        .map((c) => c.trim())
        .filter(Boolean) ?? [];
    const customColors = savedColors.filter(
      (c) => !colorEnumValues.includes(c),
    );

    return {
      garment,
      categories,
      colors: colorEnumValues,
      customColors,
      viewOwner: viewOwner ?? null,
    };
  }

  @Get(':id/clone')
  @Render('wardrobe/form')
  async cloneForm(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const viewOwner = this.parseOwnerId(ownerId);
    // findOne authorises the source garment; the clone lands in own wardrobe.
    const [garment, filters] = await Promise.all([
      this.garmentService.findOne(id, userId, viewOwner),
      this.garmentService.findAvailableFilters(viewOwner ?? userId),
    ]);
    const enumValues = Object.values(GarmentCategory) as string[];
    const customCategories = filters.categories.filter(
      (c) => !enumValues.includes(c),
    );
    const categories = [...enumValues, ...customCategories].map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    return {
      garment,
      isClone: true,
      cloneName: garment.name ? `${garment.name} (cloned)` : undefined,
      categories,
      colors: Object.values(GarmentColor),
      viewOwner: viewOwner ?? null,
    };
  }

  @Post(':id/clone')
  async cloneCreate(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      category: string;
      brand?: string;
      color?: GarmentColor;
      size?: string;
      notes?: string;
    },
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const viewOwner = this.parseOwnerId(ownerId);
    // Verify the requesting user has access to the source garment
    await this.garmentService.findOne(id, userId, viewOwner);
    const cloned = await this.garmentService.clone(
      id,
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: Array.isArray(body.color) ? body.color.join(',') : body.color,
        size: body.size,
        notes: body.notes,
      },
      userId,
    );
    return reply.redirect(`/wardrobe/${cloned.id}`, 302);
  }

  @Post(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      category?: string;
      brand?: string;
      color?: GarmentColor;
      size?: string;
      notes?: string;
      washingDetails?: string;
      dateAquired?: string;
    },
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(userId, ownerId);

    await this.garmentService.update(
      id,
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: Array.isArray(body.color) ? body.color.join(',') : body.color,
        size: body.size,
        notes: body.notes,
        washingDetails: body.washingDetails,
        dateAquired: body.dateAquired,
      },
      access.ownerId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    return reply.redirect(`/wardrobe/${id}${redirectSuffix}`, 302);
  }

  @Post(':id/photo')
  async uploadPhoto(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(userId, ownerId);

    await this.garmentService.update(
      id,
      { files: req.files({ limits: { files: 2 } }) },
      access.ownerId,
      userId,
    );
    const params = new URLSearchParams({ photoSaved: '1' });
    if (viewOwner) params.set('ownerId', String(viewOwner));
    reply.header('HX-Redirect', `/wardrobe/${id}?${params}`);
    return reply.send();
  }

  @Post(':id/archive')
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const viewOwner = this.parseOwnerId(ownerId);

    // Archive/unarchive is only allowed for the owner
    if (viewOwner != null && viewOwner !== userId) {
      throw new ForbiddenException();
    }

    await this.garmentService.archive(id, userId);
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe${redirectSuffix}`);
    return reply.send();
  }

  @Post(':id/nobg')
  async updateNobg(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { access } = await this.requireManage(userId, ownerId);

    const nobgPhoto = await req.file();
    const version = await this.garmentService.updateNobg(
      id,
      nobgPhoto,
      access.ownerId,
      userId,
    );
    // Called by the mask editor (public/js/background-removal.js) via fetch,
    // not htmx: the version lets it swap in the new immutable image URL.
    return reply.send({ version });
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @UserId() userId: number,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const viewOwner = this.parseOwnerId(ownerId);

    // Delete is only allowed for the owner
    if (viewOwner != null && viewOwner !== userId) {
      throw new ForbiddenException();
    }

    await this.garmentService.remove(id, userId);
    reply.header('HX-Redirect', '/wardrobe');
    return reply.send();
  }
}
