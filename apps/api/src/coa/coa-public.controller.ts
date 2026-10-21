import { Controller, Get, Header, Headers, HttpCode, Param, Res } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoaPublicService } from './coa-public.service';

export const PUBLIC_JSON_CACHE = 'public, max-age=30';
export const PUBLIC_PDF_CACHE = 'public, max-age=300';

interface HeaderSink {
  setHeader(name: string, value: string | number): unknown;
}
interface PdfResponse extends HeaderSink {
  status(code: number): unknown;
  end(body?: Buffer): unknown;
}

/** Quoted strong validator derived from the file's SHA-256. */
export const etagFor = (sha256: string): string => `"${sha256}"`;

/** RFC 9110 If-None-Match: `*`, or a comma list of (optionally weak) quoted tags; an unquoted bare hash is tolerated. */
export function etagMatches(header: string | undefined, sha256: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((part) => part.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === sha256);
}

/**
 * UNAUTHENTICATED verification surface (docs/api/coa-contract.md). Rate limiting is the `public` bucket in config/rate-limit.ts.
 * Cache-Control is set only on success (errors keep the global no-store), via a passthrough response.
 */
@ApiTags('public-coa')
@Controller('public')
export class CoaPublicController {
  constructor(private readonly coa: CoaPublicService) {}

  @Get('lots/:lotCode')
  @ApiOperation({ summary: 'Public COA record of a lot: current version, all non-draft versions, confirmed anchors.' })
  @ApiOkResponse({ description: 'PublicLotRecord' })
  @ApiNotFoundResponse({ description: 'Unknown lot, or a lot without any published/superseded/revoked COA.' })
  async lot(@Param('lotCode') lotCode: string, @Res({ passthrough: true }) res: HeaderSink) {
    const record = await this.coa.lotRecord(lotCode);
    res.setHeader('Cache-Control', PUBLIC_JSON_CACHE);
    return record;
  }

  @Get('lots/:lotCode/coa/:version.pdf')
  @ApiOperation({ summary: 'The COA PDF (published, superseded and revoked versions; never drafts). ETag = SHA-256, supports If-None-Match.' })
  @ApiNotFoundResponse({ description: 'Unknown lot or version, or a draft.' })
  async pdf(
    @Param('lotCode') lotCode: string,
    @Param('version') version: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: PdfResponse,
  ): Promise<void> {
    const file = await this.coa.pdf(lotCode, version);
    res.setHeader('ETag', etagFor(file.sha256));
    res.setHeader('Cache-Control', PUBLIC_PDF_CACHE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (etagMatches(ifNoneMatch, file.sha256)) {
      res.status(304);
      res.end();
      return;
    }
    const bytes = await file.load();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', bytes.length);
    res.status(200);
    res.end(bytes);
  }

  @Get('coa/by-hash/:sha256')
  @HttpCode(200)
  @ApiOperation({ summary: 'Which lot versions carry a COA file with this SHA-256 (case-insensitive hex).' })
  @ApiOkResponse({ description: '{ found, matches: [{ lotCode, version, status }] }' })
  @ApiBadRequestResponse({ description: 'Not a 64-character hex string.' })
  async byHash(@Param('sha256') sha256: string, @Res({ passthrough: true }) res: HeaderSink) {
    const result = await this.coa.byHash(sha256);
    res.setHeader('Cache-Control', PUBLIC_JSON_CACHE);
    return result;
  }

  @Get('anchor-info')
  @ApiOperation({ summary: 'Who signs anchors, on which network, and the exact memo format (so anyone can check a memo).' })
  @ApiOkResponse({ description: '{ network, publisher, memoProgramId, memoFormat, anchoringEnabled }' })
  @Header('Cache-Control', PUBLIC_JSON_CACHE)
  anchorInfo() {
    return this.coa.info();
  }
}
