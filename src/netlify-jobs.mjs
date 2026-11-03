// Keep the small KV interface used by the API while storing data in Netlify Blobs.
export function createJobsStore(store) {
  async function read(key) {
    const entry = await store.getWithMetadata(key);
    if (!entry) return null;
    if (Number(entry.metadata?.expiresAt || 0) > 0 && Number(entry.metadata.expiresAt) <= Date.now()) {
      await store.delete(key);
      return null;
    }
    return entry.data;
  }

  return {
    get: read,
    async put(key, value, options = {}) {
      const ttl = Number(options.expirationTtl || 0);
      const metadata = ttl > 0 ? {expiresAt: Date.now() + ttl * 1000} : {};
      await store.set(key, String(value), {metadata});
    },
    async delete(key) {
      await store.delete(key);
    },
    async list({prefix = "", limit = 1000} = {}) {
      const {blobs} = await store.list({prefix});
      const keys = [];
      for (const blob of blobs) {
        if (keys.length >= limit) break;
        if (await read(blob.key) !== null) keys.push({name: blob.key});
      }
      return {keys};
    },
  };
}
