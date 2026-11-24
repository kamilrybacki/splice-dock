import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProfileEntry, ProfileSource } from '../../../../profiles/registry.js';
import type { ProfileRegistry } from '../../../../profiles/registry.js';
import { RESERVED_PROFILE_NAMES } from '../../../../profiles/registry.js';
import type { ProfileAccess } from '../../../../profiles/base.js';
import type { SplicedockStore, RuntimeProfileRow } from '../../../../database/adapters/store.js';
import { profileSchema } from '../../../../../config/schema.js';
import type { ProfileConfig } from '../../../../../config/types.js';
import { exportProfilesYaml } from '../export/yaml.js';
import type { InvalidationPublisher } from '../../../../../contracts/outbound/invalidation/bus.js';
import { revokeProfileCredentials } from '../../../../secrets/broker.js';
import { dumpProfileManifest, parseProfileManifest, ProfileManifestError } from '../../../../profiles/manifest.js';

interface ManifestDocument {
  name: string;
  manifest: string;
  revision: number;
  updated_at: number;
  updated_by: string | null;
}

type ProfilesChanged = (name: string) => void | Promise<void>;

export function registerProfileRoutes(
  app: FastifyInstance,
  profileRegistry: ProfileRegistry,
  profileService: ProfileAccess,
  store?: SplicedockStore,
  invalidation?: InvalidationPublisher,
  onProfilesChanged?: ProfilesChanged,
): void {
  const completeProfile = (entry: ProfileEntry): ProfileConfig => ({
    tools: entry.tools,
    enable_code_mode: entry.enable_code_mode === true,
    credentials: entry.credentials ?? {},
  });

  const documentFromRow = (row: RuntimeProfileRow, fallback?: ProfileConfig): ManifestDocument => ({
    name: row.name,
    manifest: row.manifest_yaml ?? dumpProfileManifest(fallback ?? { tools: row.tools, enable_code_mode: false, credentials: {} }),
    revision: row.revision,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  });

  const currentDocument = async (name: string): Promise<ManifestDocument | null> => {
    const entry = profileRegistry.getProfile(name);
    if (store) {
      const row = await store.getRuntimeProfile(name);
      if (row) return documentFromRow(row, entry ? completeProfile(entry) : undefined);
    }
    if (!entry) return null;
    return {
      name,
      manifest: dumpProfileManifest(completeProfile(entry)),
      revision: entry.revision ?? 1,
      updated_at: entry.updated_at ?? 0,
      updated_by: entry.updated_by ?? null,
    };
  };

  const commit = async (
    name: string,
    profile: ProfileConfig,
    manifest: string,
    baseRevision: number,
    origin: ProfileSource,
  ): Promise<{ status: 'ok'; document: ManifestDocument } | { status: 'conflict'; current: ManifestDocument | null }> => {
    if (store) {
      const result = await store.saveRuntimeProfile(name, profile, manifest, 'admin-ui', baseRevision, origin);
      if (result.status === 'conflict') {
        const current = await currentDocument(name);
        return { status: 'conflict', current };
      }
      profileRegistry.loadCatalogProfile(name, {
        source: result.row.origin,
        ...profile,
        revision: result.row.revision,
        updated_at: result.row.updated_at,
        updated_by: result.row.updated_by,
      });
      await onProfilesChanged?.(name);
      await invalidation?.publish('profiles', name);
      return { status: 'ok', document: documentFromRow(result.row, profile) };
    }

    const entry = profileRegistry.getProfile(name);
    if ((entry?.revision ?? (entry ? 1 : 0)) !== baseRevision) {
      return { status: 'conflict', current: await currentDocument(name) };
    }
    const document: ManifestDocument = {
      name,
      manifest,
      revision: baseRevision + 1,
      updated_at: Date.now(),
      updated_by: 'admin-ui',
    };
    profileRegistry.loadCatalogProfile(name, { source: origin, ...profile, ...document });
    await onProfilesChanged?.(name);
    await invalidation?.publish('profiles', name);
    return { status: 'ok', document };
  };

  const conflict = (reply: FastifyReply, current: ManifestDocument | null): FastifyReply => reply.code(409).send({
    error: {
      code: current ? 'revision_conflict' : 'profile_exists_or_changed',
      message: current ? 'Profile changed since it was loaded; reload or resolve the latest revision' : 'Profile revision changed concurrently',
      ...(current ? { current } : {}),
    },
  });

  const validationFailure = (reply: FastifyReply, error: unknown): FastifyReply | undefined => {
    if (!(error instanceof ProfileManifestError)) return undefined;
    return reply.code(422).send({ error: { code: 'validation_error', message: error.message, details: error.details } });
  };

  app.get('/api/v1/profiles', async (req, reply) => {
    const format = (req.query as Record<string, string>)['format'];
    if (format === 'yaml') {
      reply.type('application/yaml').send(exportProfilesYaml(profileRegistry));
      return;
    }
    reply.send({
      data: profileRegistry.getAllProfiles().map(entry => ({
        ...entry,
        ...completeProfile(entry),
      })),
    });
  });

  app.get('/api/v1/profiles/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const profile = profileRegistry.getProfile(name);
    if (!profile) { reply.code(404).send({ error: { code: 'not_found', message: `Profile '${name}' not found` } }); return; }
    const resolvedTools = profileService.getToolsForProfile(name).map(tool => tool.name);
    reply.send({ data: { name, ...profile, ...completeProfile(profile), resolved_tools: resolvedTools } });
  });

  app.get('/api/v1/profiles/:name/manifest', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const document = await currentDocument(name);
    if (!document) { reply.code(404).send({ error: { code: 'not_found', message: `Profile '${name}' not found` } }); return; }
    reply.send({ data: document });
  });

  app.post('/api/v1/profiles/validate', async (req, reply) => {
    const body = req.body as { manifest?: unknown; name?: unknown };
    if (typeof body?.manifest !== 'string' || (body.name !== undefined && typeof body.name !== 'string')) {
      reply.code(400).send({ error: { code: 'bad_request', message: 'manifest must be a string and name, when supplied, must be a string' } });
      return;
    }
    try {
      const parsed = parseProfileManifest(body.manifest, body.name as string | undefined);
      reply.send({ data: { valid: true, name: parsed.name, profile: parsed.profile } });
    } catch (error) {
      if (validationFailure(reply, error)) return;
      throw error;
    }
  });

  app.post('/api/v1/profiles/manifest', async (req, reply) => {
    const body = req.body as { manifest?: unknown };
    if (typeof body?.manifest !== 'string') {
      reply.code(400).send({ error: { code: 'bad_request', message: 'manifest must be a string' } });
      return;
    }
    try {
      const parsed = parseProfileManifest(body.manifest);
      if (RESERVED_PROFILE_NAMES.has(parsed.name) || parsed.name === '__no_tools__') {
        reply.code(409).send({ error: { code: 'conflict', message: `Profile '${parsed.name}' is reserved` } });
        return;
      }
      if (await currentDocument(parsed.name)) {
        reply.code(409).send({ error: { code: 'profile_exists', message: `Profile '${parsed.name}' already exists` } });
        return;
      }
      const result = await commit(parsed.name, parsed.profile, body.manifest, 0, 'runtime');
      if (result.status === 'conflict') { conflict(reply, result.current); return; }
      reply.code(201).header('Location', `/api/v1/profiles/${parsed.name}`).send({ data: result.document });
    } catch (error) {
      if (validationFailure(reply, error)) return;
      throw error;
    }
  });

  app.put('/api/v1/profiles/:name/manifest', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const body = req.body as { manifest?: unknown; base_revision?: unknown };
    if (typeof body?.manifest !== 'string' || !Number.isInteger(body.base_revision) || (body.base_revision as number) < 1) {
      reply.code(400).send({ error: { code: 'bad_request', message: 'manifest must be a string and base_revision must be a positive integer' } });
      return;
    }
    const current = await currentDocument(name);
    if (!current) { reply.code(404).send({ error: { code: 'not_found', message: `Profile '${name}' not found` } }); return; }
    const source = profileRegistry.getProfile(name)?.source ?? 'runtime';
    try {
      const parsed = parseProfileManifest(body.manifest, name);
      const result = await commit(name, parsed.profile, body.manifest, body.base_revision as number, source);
      if (result.status === 'conflict') { conflict(reply, result.current); return; }
      reply.send({ data: result.document });
    } catch (error) {
      if (validationFailure(reply, error)) return;
      throw error;
    }
  });

  // Legacy JSON adapter. New clients and the browser editor use manifests.
  app.post('/api/v1/profiles', async (req, reply) => {
    const body = req.body as { name?: string; tools?: string[]; enable_code_mode?: boolean; credentials?: ProfileConfig['credentials'] };
    if (!body?.name) { reply.code(400).send({ error: { code: 'bad_request', message: "'name' is required" } }); return; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(body.name) || RESERVED_PROFILE_NAMES.has(body.name)) {
      reply.code(RESERVED_PROFILE_NAMES.has(body.name) ? 409 : 422).send({
        error: { code: RESERVED_PROFILE_NAMES.has(body.name) ? 'conflict' : 'validation_error', message: 'invalid or reserved profile name' },
      });
      return;
    }
    const current = await currentDocument(body.name);
    const existing = profileRegistry.getProfile(body.name);
    const parsed = profileSchema.safeParse({
      tools: body.tools ?? existing?.tools,
      enable_code_mode: body.enable_code_mode ?? existing?.enable_code_mode,
      credentials: body.credentials ?? existing?.credentials,
    });
    if (!parsed.success) { reply.code(422).send({ error: { code: 'validation_error', message: 'Invalid profile', details: parsed.error.issues } }); return; }
    const result = await commit(
      body.name,
      parsed.data,
      dumpProfileManifest(parsed.data),
      current?.revision ?? 0,
      existing?.source ?? 'runtime',
    );
    if (result.status === 'conflict') { conflict(reply, result.current); return; }
    reply.code(201).header('Location', `/api/v1/profiles/${body.name}`).send({ data: { name: body.name, ...parsed.data } });
  });

  app.delete('/api/v1/profiles/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (name === '__no_tools__') { reply.code(409).send({ error: { code: 'conflict', message: 'The empty-profile sentinel cannot be deleted' } }); return; }
    const existing = profileRegistry.getProfile(name);
    const removed = await store?.deleteRuntimeProfile(name) ?? false;
    if (!existing && !removed) {
      reply.code(404).send({ error: { code: 'not_found', message: `Profile '${name}' not found` } });
      return;
    }
    profileRegistry.removeProfile(name);
    await revokeProfileCredentials(name).catch(() => {});
    await onProfilesChanged?.(name);
    await invalidation?.publish('profiles', name);
    reply.code(204).send();
  });
}
