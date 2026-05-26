import { Storage } from '@google-cloud/storage';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<string>; // returns gs:// url
  get(key: string): Promise<Buffer>;
}

export function createGcsObjectStore(opts: {
  bucket: string;
  apiEndpoint?: string;
  projectId?: string;
}): ObjectStore {
  const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID;
  const storage = new Storage({
    ...(projectId !== undefined ? { projectId } : {}),
    ...(opts.apiEndpoint ? { apiEndpoint: opts.apiEndpoint } : {}),
  });
  const bucket = storage.bucket(opts.bucket);
  return {
    async put(key, body, contentType) {
      await bucket.file(key).save(body, { contentType, resumable: false });
      return `gs://${opts.bucket}/${key}`;
    },
    async get(key) {
      const [buf] = await bucket.file(key).download();
      return buf;
    },
  };
}
