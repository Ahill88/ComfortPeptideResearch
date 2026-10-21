import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Header,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminRoles, CurrentAdmin, RequestIp } from '../admin/admin.decorators';
import type { AdminPrincipal } from '../admin/admin.types';
import { AnchorRetryBody, CreateLotBody, ListLotsQuery, PublishCoaBody, RevokeCoaBody } from './coa-admin.dto';
import { type AdminActor, CoaAdminService } from './coa-admin.service';
import { MAX_PDF_BYTES, type UploadedPdfFile } from './coa-validation';

const NO_STORE = () => Header('Cache-Control', 'no-store');
const actorOf = (admin: AdminPrincipal, ip: string | null): AdminActor => ({ id: admin.id, role: admin.role, ip });

/** Minimal response surface used to send the PDF (no @types/express in this workspace). */
interface FileResponse {
  setHeader(name: string, value: string | number): unknown;
  end(body: Buffer): unknown;
}

/**
 * multer (memory storage) bundled in @nestjs/platform-express. One file in the `file` field, bounded text fields. Oversize is the
 * admin's validation error (400 like every other upload rejection), not a bare 413. The file type is decided later from the bytes.
 */
const MulterFile = FileInterceptor('file', {
  limits: { fileSize: MAX_PDF_BYTES + 1, files: 1, fields: 12, fieldSize: 4096, parts: 16, headerPairs: 64 },
});

@Injectable()
export class CoaUploadInterceptor implements NestInterceptor {
  private readonly inner = new MulterFile();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.inner.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw new BadRequestException('The file is larger than 10 MB.');
      throw error;
    }
  }
}

@ApiTags('admin-coa')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly coa: CoaAdminService) {}

  @Get('products')
  @NO_STORE()
  @ApiOperation({ summary: 'Every product with its lot and published-COA-lot counts.' })
  @ApiOkResponse({ description: '{ items: [{ id, sku, slug, name, active, priceCents, inventory, lotCount, publishedCoaLotCount }] }' })
  products() {
    return this.coa.listProducts();
  }

  @Post('products/:id/publish')
  @AdminRoles('OWNER')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'OWNER: activate a product. With REQUIRE_PUBLISHED_COA=true it needs a lot with a published COA.' })
  @ApiForbiddenResponse({ description: 'Not an owner.' })
  @ApiNotFoundResponse({ description: 'Unknown product.' })
  @ApiConflictResponse({ description: 'Product has no lot with a published COA.' })
  publish(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.publishProduct(id, actorOf(admin, ip));
  }

  @Post('products/:id/unpublish')
  @AdminRoles('OWNER')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'OWNER: deactivate a product.' })
  @ApiForbiddenResponse({ description: 'Not an owner.' })
  @ApiNotFoundResponse({ description: 'Unknown product.' })
  unpublish(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.unpublishProduct(id, actorOf(admin, ip));
  }
}

@ApiTags('admin-coa')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/lots')
export class AdminLotsController {
  constructor(private readonly coa: CoaAdminService) {}

  @Get()
  @NO_STORE()
  @ApiOperation({ summary: 'List lots (keyset by code) with their COA / anchor status.' })
  @ApiBadRequestResponse({ description: 'Bad limit or cursor.' })
  list(@Query() query: ListLotsQuery) {
    return this.coa.listLots(query);
  }

  @Post()
  @NO_STORE()
  @ApiOperation({ summary: 'Create a lot (placeholder purity 0, coaKey PENDING-NO-COA). STAFF or OWNER.' })
  @ApiBadRequestResponse({ description: 'Invalid lot code.' })
  @ApiConflictResponse({ description: 'Duplicate lot code.' })
  create(@Body() body: CreateLotBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.createLot(body, actorOf(admin, ip));
  }

  @Get(':id')
  @NO_STORE()
  @ApiOperation({ summary: 'A lot and all its COA versions, newest first.' })
  @ApiNotFoundResponse({ description: 'Unknown lot.' })
  detail(@Param('id') id: string) {
    return this.coa.getLot(id);
  }

  @Post(':id/coas')
  @UseInterceptors(CoaUploadInterceptor)
  @NO_STORE()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a DRAFT COA (PDF only, <= 10 MB). The SHA-256 is computed by the server. STAFF or OWNER.' })
  @ApiBadRequestResponse({ description: 'Not a PDF, empty, too large, or invalid fields.' })
  @ApiConflictResponse({ description: 'The same file is already on this lot.' })
  upload(
    @Param('id') id: string,
    @UploadedFile() file: UploadedPdfFile | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: AdminPrincipal,
    @RequestIp() ip: string | null,
  ) {
    return this.coa.upload(id, file, body, actorOf(admin, ip));
  }
}

@ApiTags('admin-coa')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/coas')
export class AdminCoasController {
  constructor(private readonly coa: CoaAdminService) {}

  @Get(':id/file')
  @ApiOperation({ summary: 'The stored PDF in any status (admin review).' })
  @ApiNotFoundResponse({ description: 'Unknown COA.' })
  async file(@Param('id') id: string, @Res() res: FileResponse): Promise<void> {
    const { bytes } = await this.coa.getFile(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', bytes.length);
    res.end(bytes);
  }

  @Post(':id/publish')
  @AdminRoles('OWNER')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'OWNER: publish a draft. confirmSha256 must equal the stored hash. Supersedes the previous published version.' })
  @ApiBadRequestResponse({ description: 'confirmSha256 missing or not the stored hash.' })
  @ApiForbiddenResponse({ description: 'Not an owner.' })
  @ApiConflictResponse({ description: 'Not a draft (including a double click).' })
  publish(@Param('id') id: string, @Body() body: PublishCoaBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.publish(id, body?.confirmSha256, actorOf(admin, ip));
  }

  @Post(':id/revoke')
  @AdminRoles('OWNER')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'OWNER: revoke a published or superseded COA (reason required).' })
  @ApiBadRequestResponse({ description: 'Missing or over-long reason.' })
  @ApiForbiddenResponse({ description: 'Not an owner.' })
  @ApiConflictResponse({ description: 'Draft or already revoked.' })
  revoke(@Param('id') id: string, @Body() body: RevokeCoaBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.revoke(id, body?.reason, actorOf(admin, ip));
  }

  @Delete(':id')
  @HttpCode(204)
  @NO_STORE()
  @ApiOperation({ summary: 'Delete a DRAFT (owner, or the admin who uploaded it).' })
  @ApiForbiddenResponse({ description: 'Neither an owner nor the uploader.' })
  @ApiConflictResponse({ description: 'Not a draft.' })
  async remove(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null): Promise<void> {
    await this.coa.delete(id, actorOf(admin, ip));
  }

  @Post(':id/anchor/retry')
  @AdminRoles('OWNER')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'OWNER: ask the anchoring service to retry the PUBLISH or REVOKE anchor.' })
  @ApiConflictResponse({ description: 'The COA has not reached that state.' })
  retry(@Param('id') id: string, @Body() body: AnchorRetryBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.coa.retryAnchor(id, body?.kind, actorOf(admin, ip));
  }
}
