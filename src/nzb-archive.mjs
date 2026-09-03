import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FORWARDED_ADD_PARAMETERS } from './sab-client.mjs';

function notFound() {
  const error = new Error('Saved NZB was not found. It may have expired or been deleted.');
  error.statusCode = 404;
  return error;
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function publicItem(metadata) {
  return {
    id: metadata.id,
    filename: metadata.filename,
    storedFilename: metadata.storedFilename,
    contentType: metadata.contentType,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    sourceHost: metadata.sourceHost,
    egressIp: metadata.egressIp,
    createdAt: metadata.createdAt,
    submittedAt: metadata.submittedAt,
    submitCount: metadata.submitCount,
    sabJobId: metadata.sabJobId,
    lastSabStatus: metadata.lastSabStatus
  };
}

function savedParameters(parameters) {
  const result = {};
  for (const name of FORWARDED_ADD_PARAMETERS) {
    const value = parameters.get(name);
    if (value !== null && value !== '') result[name] = value;
  }
  return result;
}

export class NzbArchive {
  constructor(directory, options = {}) {
    if (!directory) throw new Error('NZB archive directory is required.');
    this.directory = directory;
    this.now = options.now || (() => Date.now());
    this.items = new Map();
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    for (const name of names.filter(value => value.endsWith('.json'))) {
      try {
        const metadata = JSON.parse(await readFile(path.join(this.directory, name), 'utf8'));
        if (!metadata.id || !metadata.storedFilename || path.basename(metadata.storedFilename) !== metadata.storedFilename) continue;
        await stat(path.join(this.directory, metadata.storedFilename));
        this.items.set(metadata.id, metadata);
      } catch {
        // A damaged sidecar or orphan is ignored without affecting healthy NZBs.
      }
    }
    return this.list();
  }

  async save(nzb, parameters, context = {}) {
    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const timestamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const storedFilename = `${timestamp}-${id.slice(0, 8)}-${nzb.filename}`;
    const metadata = {
      id,
      filename: nzb.filename,
      storedFilename,
      contentType: nzb.contentType || 'application/x-nzb',
      bytes: nzb.bytes.byteLength,
      sha256: createHash('sha256').update(nzb.bytes).digest('hex'),
      sourceHost: context.sourceHost || '',
      egressIp: context.egressIp || '',
      createdAt,
      submittedAt: '',
      submitCount: 0,
      sabJobId: '',
      lastSabStatus: null,
      parameters: savedParameters(parameters)
    };

    await writeFile(path.join(this.directory, storedFilename), nzb.bytes, { mode: 0o600 });
    await this.writeMetadata(metadata);
    this.items.set(id, metadata);
    return publicItem(metadata);
  }

  list() {
    return [...this.items.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicItem);
  }

  async read(id) {
    const metadata = this.items.get(id);
    if (!metadata) throw notFound();
    let bytes;
    try {
      bytes = await readFile(path.join(this.directory, metadata.storedFilename));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.items.delete(id);
        throw notFound();
      }
      throw error;
    }
    const parameters = new URLSearchParams({ output: 'json', ...metadata.parameters });
    return {
      item: publicItem(metadata),
      nzb: {
        bytes,
        filename: metadata.filename,
        contentType: metadata.contentType
      },
      parameters
    };
  }

  async markSubmitted(id, result = {}) {
    const metadata = this.items.get(id);
    if (!metadata) throw notFound();
    metadata.submittedAt = new Date(this.now()).toISOString();
    metadata.submitCount += 1;
    metadata.sabJobId = String(result.sabJobId || '');
    metadata.lastSabStatus = Number.isInteger(result.sabStatus) ? result.sabStatus : null;
    await this.writeMetadata(metadata);
    return publicItem(metadata);
  }

  async remove(id) {
    const metadata = this.items.get(id);
    if (!metadata) throw notFound();
    await unlinkIfPresent(path.join(this.directory, metadata.storedFilename));
    await unlinkIfPresent(this.metadataPath(id));
    this.items.delete(id);
  }

  async cleanup(retentionHours) {
    const hours = Number(retentionHours);
    if (hours === 0) return { removed: 0 };
    if (!Number.isFinite(hours) || hours < 1) return { removed: 0 };
    const cutoff = this.now() - hours * 60 * 60 * 1000;
    let removed = 0;
    for (const metadata of [...this.items.values()]) {
      const created = Date.parse(metadata.createdAt);
      if (Number.isFinite(created) && created <= cutoff) {
        await this.remove(metadata.id);
        removed += 1;
      }
    }
    return { removed };
  }

  metadataPath(id) {
    return path.join(this.directory, `${id}.json`);
  }

  async writeMetadata(metadata) {
    const finalPath = this.metadataPath(metadata.id);
    const temporaryPath = `${finalPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);
  }
}
