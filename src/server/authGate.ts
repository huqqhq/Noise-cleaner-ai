import fs from 'node:fs';
import path from 'node:path';

export const OWNER_EMAIL = 'sanjeeta1320@gmail.com';

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

export interface VerifiedSubscriber {
  uid: string;
  email: string;
  utr: string;
  expiresAtMs: number;
  isOwner: boolean;
}

let cachedConfig: FirebaseAppletConfig | null = null;

function getFirebaseConfig(): FirebaseAppletConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  cachedConfig = JSON.parse(raw) as FirebaseAppletConfig;
  return cachedConfig;
}

interface FirestoreFieldValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
}

interface FirestoreDocResponse {
  fields?: Record<string, FirestoreFieldValue>;
}

/**
 * Cryptographically verifies the caller's Firebase Google ID token via Identity Toolkit REST.
 * - Grants automatic free unlimited access to the owner account (sanjeeta1320@gmail.com).
 * - For all other users, verifies an active, non-revoked, non-expired Rs. 49 subscription from Firestore.
 */
export async function verifyActiveSubscriber(idToken: string): Promise<VerifiedSubscriber> {
  if (!idToken || idToken.length < 20) {
    throw new Error('AUTH_REQUIRED');
  }

  const config = getFirebaseConfig();

  // 1. Verify Firebase ID Token via Google Identity Toolkit REST
  const lookupRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );

  if (!lookupRes.ok) {
    const errText = await lookupRes.text().catch(() => '');
    console.error('IdentityToolkit token lookup failed:', lookupRes.status, errText);
    throw new Error('INVALID_TOKEN');
  }

  const lookupJson = (await lookupRes.json()) as {
    users?: Array<{
      localId?: string;
      email?: string;
      emailVerified?: boolean;
    }>;
  };

  const user = lookupJson.users?.[0];
  if (!user?.localId || !user.email || !user.emailVerified) {
    throw new Error('UNVERIFIED_ACCOUNT');
  }

  const uid = user.localId;
  const email = user.email;

  // Owner ID gets free unlimited access without payment/UTR check
  if (email.toLowerCase() === OWNER_EMAIL) {
    return {
      uid,
      email,
      utr: 'OWNER_FREE',
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      isOwner: true,
    };
  }

  // 2. Fetch the user's subscription directly from Firestore using their verified ID token
  const dbId = config.firestoreDatabaseId || '(default)';
  const docUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    config.projectId,
  )}/databases/${encodeURIComponent(dbId)}/documents/subscriptions/${encodeURIComponent(uid)}`;

  const subRes = await fetch(docUrl, {
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (subRes.status === 404) {
    throw new Error('SUBSCRIPTION_REQUIRED');
  }

  if (!subRes.ok) {
    const errText = await subRes.text().catch(() => '');
    console.error('Firestore subscription check failed:', subRes.status, errText);
    throw new Error('SUBSCRIPTION_CHECK_FAILED');
  }

  const subDoc = (await subRes.json()) as FirestoreDocResponse;
  const fields = subDoc.fields ?? {};
  const status = fields.status?.stringValue ?? '';
  const utr = fields.utr?.stringValue ?? '';
  const revokeCount =
    Number(fields.revokeCount?.integerValue ?? fields.revokeCount?.doubleValue ?? 0) || 0;
  const expiresAtMs =
    Number(fields.expiresAtMs?.integerValue ?? fields.expiresAtMs?.doubleValue ?? 0) || 0;

  if (revokeCount >= 2) {
    throw new Error('ACCOUNT_BANNED');
  }

  if (status === 'revoked') {
    throw new Error('SUBSCRIPTION_REVOKED');
  }

  if (status !== 'active' || !utr || expiresAtMs <= Date.now()) {
    throw new Error('SUBSCRIPTION_REQUIRED');
  }

  return {
    uid,
    email,
    utr,
    expiresAtMs,
    isOwner: false,
  };
}
