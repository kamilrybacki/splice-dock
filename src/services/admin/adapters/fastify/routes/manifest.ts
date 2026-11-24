import type { FastifyInstance } from 'fastify';
import type { ToolRegistry } from '../../../../tools/registry.js';
import type { ProfileRegistry } from '../../../../profiles/registry.js';
import type { SplicedockConfig } from '../../../../../config/types.js';
import { exportFullManifest } from '../export/yaml.js';

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
