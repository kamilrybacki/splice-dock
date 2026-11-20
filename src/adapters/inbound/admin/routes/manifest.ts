import type { FastifyInstance } from 'fastify';
import type { ToolRegistry } from '../../../../application/registry/tool-registry.js';
import type { ProfileRegistry } from '../../../../application/registry/profile-registry.js';
import type { SplicedockConfig } from '../../../../config/types.js';
import { exportFullManifest } from '../../../outbound/export/yaml-exporter.js';

export function registerManifestRoutes(
  app: FastifyInstance,
  toolRegistry: ToolRegistry,
  profileRegistry: ProfileRegistry,
  serverConfig: SplicedockConfig['server'],
): void {
  app.get('/api/v1/manifest', async (_req, reply) => {
    const manifest = exportFullManifest(toolRegistry, profileRegistry, serverConfig);
    reply
      .type('application/yaml')
      .header('Content-Disposition', 'attachment; filename="splicedock.yaml"')
      .send(manifest);
  });
}
