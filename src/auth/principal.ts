export type Principal =
  | {
      kind: 'user';
      tenantId: string;
      userId: string;
      subject: string;
      scopes: string[];
      role: 'owner' | 'admin' | 'operator' | 'viewer';
    }
  | {
      kind: 'service';
      tenantId: string;
      apiKeyId: string;
      subject: string;
      scopes: string[];
    };
