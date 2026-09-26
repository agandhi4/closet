import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Render,
  Req,
  Res,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { UserId } from '../auth/user.decorator';
import { WardrobeShareService } from './wardrobe-share.service';
import { SharePermission } from '../dal/entity/wardrobe-share.entity';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Every route needs a session (SessionGuard) except the invite landing page,
// which an anonymous recipient must be able to open before signing in.
@Controller('wardrobe-share')
export class WardrobeShareController {
  private readonly logger = new Logger(WardrobeShareController.name);

  constructor(private readonly shareService: WardrobeShareService) {}

  @Get('manage')
  @Render('wardrobe-share/manage')
  async manage(
    @UserId() userId: number,
    @Req() req: FastifyRequest,
    @Query('error') error: string | undefined,
  ) {
    const [outbound, inbound, pending] = await Promise.all([
      this.shareService.getOutboundShares(userId),
      this.shareService.getInboundShares(userId),
      this.shareService.getPendingShares(userId),
    ]);

    const mapShare = (s: any) => ({
      id: s.id,
      grantor: s.grantor?.unwrap?.() ?? s.grantor,
      grantee: s.grantee?.unwrap?.() ?? s.grantee,
      permission: s.permission,
      inviteToken: s.inviteToken,
      acceptedAt: s.acceptedAt,
    });

    return {
      outbound: outbound.map(mapShare),
      inbound: inbound.map(mapShare),
      pending: pending.map(mapShare),
      baseUrl: `${req.protocol}://${req.headers.host}`,
      error: error ?? null,
    };
  }

  @Post('create-invite-link')
  async createInviteLink(
    @UserId() userId: number,
    @Body() body: { permission: SharePermission },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const share = await this.shareService.createInviteLink(
      userId,
      body.permission || SharePermission.VIEW,
    );
    const inviteUrl = `${req.protocol}://${req.headers.host}/wardrobe-share/invite/${share.inviteToken}`;

    if (req.headers['hx-request']) {
      return reply.viewPartial('wardrobe-share/partials/invite-link-result', {
        inviteUrl,
      });
    }

    return reply.redirect('/wardrobe-share/manage', 302);
  }

  @Post(':id/remove')
  async removeShare(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) shareId: number,
    @Res() reply: FastifyReply,
  ) {
    await this.shareService.removeShare(shareId, userId);
    return reply.redirect('/wardrobe-share/manage', 302);
  }

  // @Public(): the anonymous recipient must see what they were invited to
  // before being asked to sign in. The session, if any, is already on
  // req.auth from the preHandler in app.ts.
  @Public()
  @Get('invite/:token')
  @Render('wardrobe-share/invite')
  async viewInvite(@Param('token') token: string, @Req() req: FastifyRequest) {
    const share = await this.shareService.findInviteByToken(token);
    if (!share) {
      return { error: true, message: 'Invite not found or has expired.' };
    }

    const permissionLabel =
      share.permission === SharePermission.VIEW ? 'View only' : 'Can edit';

    return {
      share,
      permissionLabel,
      grantorName:
        share.grantor.unwrap().firstName ||
        share.grantor.unwrap().email ||
        'A user',
      token,
      isLoggedIn: req.auth !== undefined,
    };
  }

  @Post('invite/:token/accept')
  async acceptInvite(
    @UserId() userId: number,
    @Param('token') token: string,
    @Res() reply: FastifyReply,
  ) {
    try {
      await this.shareService.acceptInvite(token, userId);
    } catch (e) {
      if (
        e instanceof BadRequestException ||
        e instanceof ForbiddenException ||
        e instanceof NotFoundException
      ) {
        return reply.redirect(
          `/wardrobe-share/manage?error=${encodeURIComponent(e.message)}`,
          302,
        );
      }
      this.logger.warn(e);
    }
    return reply.redirect('/wardrobe-share/manage', 302);
  }

  @Post('invite/:token/decline')
  async declineInvite(
    @UserId() userId: number,
    @Param('token') token: string,
    @Res() reply: FastifyReply,
  ) {
    try {
      await this.shareService.declineInvite(token, userId);
    } catch (e) {
      this.logger.warn(e);
    }
    return reply.redirect('/wardrobe-share/manage', 302);
  }
}
