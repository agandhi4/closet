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
  UseGuards,
} from '@nestjs/common';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { GarmentCategory } from './garment-category.enum';
import { GarmentColor } from './garment-color.enum';
import { GarmentService } from './garment.service';
import {
  WardrobeAccess,
  WardrobeShareService,
} from '../wardrobe-share/wardrobe-share.service';
import type { SearchGarmentDto } from './dto/search-garment.dto';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface RequestAccess {
  userId: number | undefined;
  /** Wardrobe named by `?ownerId=`; undefined for the requester's own. */
  viewOwner: number | undefined;
  access: WardrobeAccess;
}

@UseGuards(ConditionalAuthGuard)
@Controller('wardrobe')
export class WardrobeController {
  private readonly logger = new Logger(WardrobeController.name);

  constructor(
    private readonly garmentService: GarmentService,
    private readonly shareService: WardrobeShareService,
  ) {}

  private userId(req: FastifyRequest): number | undefined {
    return req.user?.userId;
  }

  private parseOwnerId(ownerId: string | undefined): number | undefined {
    return ownerId ? parseInt(ownerId, 10) : undefined;
  }

  private async resolveAccess(
    req: FastifyRequest,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const userId = this.userId(req);
    const viewOwner = this.parseOwnerId(ownerId);
    const access = await this.shareService.resolveAccess(userId, viewOwner);
    return { userId, viewOwner, access };
  }

  private async requireView(
    req: FastifyRequest,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const resolved = await this.resolveAccess(req, ownerId);
    if (!resolved.access.canView) throw new ForbiddenException();
    return resolved;
  }

  private async requireManage(
    req: FastifyRequest,
    ownerId: string | undefined,
  ): Promise<RequestAccess> {
    const resolved = await this.resolveAccess(req, ownerId);
    if (!resolved.access.canManage) throw new ForbiddenException();
    return resolved;
  }

  @Get()
  @Render('wardrobe/index')
  async index(
    @Req() req: FastifyRequest,
    @Query() query: SearchGarmentDto,
    @Query('ownerId') ownerId: string | undefined,
    @I18n() i18n: I18nContext,
  ) {
    const { userId, access } = await this.requireView(req, ownerId);
    // A share to yourself cannot exist, so `?ownerId=<self>` is the own
    // wardrobe and the view must not render it as a shared one.
    const viewOwner = access.isOwner ? undefined : access.ownerId;

    let sharedWardrobes: any[] = [];
    if (userId != null) {
      sharedWardrobes = await this.shareService.getInboundShares(userId);
      sharedWardrobes = sharedWardrobes.map((s) => ({
        id: s.id,
        grantorId: s.grantor.unwrap().id,
        grantorName: s.grantor.unwrap().firstName || s.grantor.unwrap().email,
        permission: s.permission,
      }));
    }

    const [garments, filters] = await Promise.all([
      this.garmentService.findAll(userId, query, viewOwner),
      this.garmentService.findAvailableFilters(access.ownerId),
    ]);
    const availableCategories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    return {
      garments,
      availableCategories,
      colors: Object.values(GarmentColor),
      availableSizes: filters.sizes,
      search: query,
      sharedWardrobes,
      viewOwner: viewOwner ?? null,
      canEdit: access.canManage,
    };
  }

  @Get('new')
  @Render('wardrobe/form')
  async newForm(
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(req, ownerId);
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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { viewOwner, access } = await this.requireManage(req, ownerId);

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
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
    @Query('created') created: string | undefined,
    @Query('photoSaved') photoSaved: string | undefined,
  ) {
    const { userId, viewOwner, access } = await this.requireView(req, ownerId);
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
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { userId, viewOwner, access } = await this.requireManage(
      req,
      ownerId,
    );

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
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { userId, viewOwner, access } = await this.requireManage(
      req,
      ownerId,
    );

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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { userId, viewOwner, access } = await this.requireManage(
      req,
      ownerId,
    );

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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const { userId, access } = await this.requireManage(req, ownerId);

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
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
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
