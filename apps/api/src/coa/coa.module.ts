import { DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';
import { AdminCatalogController, AdminCoasController, AdminLotsController, CoaUploadInterceptor } from './coa-admin.controller';
import { CoaAdminService } from './coa-admin.service';
import { CoaPublicController } from './coa-public.controller';
import { CoaPublicService } from './coa-public.service';

/**
 * COA core: admin catalog/lot/COA endpoints (/v1/admin) and the public verification endpoints (/v1/public).
 * PrismaService, AdminSessionGuard and AdminAuditService come from the global modules.
 *
 * Optional extension points (both injected with @Optional, so the plain module works with neither):
 *   COA_ANCHOR_PORT  (./coa.types)        called after a publish/revoke commits; supplied by the anchoring module
 *   COA_ANCHOR_INFO  (./coa-anchor-info)  public anchoring facts for GET /v1/public/anchor-info
 * Supply them through `CoaModule.register({ imports: [AnchorModule], providers: [{ provide: COA_ANCHOR_INFO, useValue: ... }] })`.
 */
@Module({
  controllers: [AdminCatalogController, AdminLotsController, AdminCoasController, CoaPublicController],
  providers: [CoaAdminService, CoaPublicService, CoaUploadInterceptor],
  exports: [CoaAdminService],
})
export class CoaModule {
  static register(options: { imports?: ModuleMetadata['imports']; providers?: Provider[] } = {}): DynamicModule {
    return { module: CoaModule, imports: options.imports ?? [], providers: options.providers ?? [] };
  }
}
