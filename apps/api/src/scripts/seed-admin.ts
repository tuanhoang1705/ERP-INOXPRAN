import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { authenticator } from 'otplib';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { hashPassword } from '../modules/auth/password';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

function encryptSecret(value: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

async function seed(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const jwtSecret = process.env.JWT_SECRET;
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!uri || !jwtSecret || !email || !password) {
    throw new Error('MONGODB_URI, JWT_SECRET, ADMIN_EMAIL và ADMIN_PASSWORD là bắt buộc');
  }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const configuredSecret = process.env.ADMIN_TOTP_SECRET;
    const secret = configuredSecret || authenticator.generateSecret();
    const encryptionKey = process.env.MFA_ENCRYPTION_KEY ?? jwtSecret;
    const now = new Date();
    await db.collection('users').updateOne(
      { email },
      {
        $set: {
          displayName: process.env.ADMIN_NAME ?? 'Quản trị INOXPRAN',
          passwordHash: await hashPassword(password),
          // Tài khoản quản trị gốc: cấp / thu hồi vai trò Quản trị, không bị khóa hay đổi quyền qua giao diện.
          roles: ['ADMIN'],
          root: true,
          warehouseScopes: [],
          status: 'ACTIVE',
          mfaEnabled: true,
          mfaSecret: encryptSecret(secret, encryptionKey),
          updatedAt: now,
        },
        $inc: { tokenVersion: 1 },
        $unset: { mustChangePassword: '', lockedUntil: '', failedLoginCount: '' },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true },
    );
    await Promise.all([
      db.collection<{ _id: string }>('settings').updateOne(
        { _id: 'pricing' },
        {
          $setOnInsert: {
            defaultTaxRate: '8',
            pricesIncludeTax: true,
            discountCapRate: '18',
            customerTierDiscounts: { TIER_1: '8', TIER_2: '5', RETAIL: '0' },
            volumeRules: [
              { minimumBaseQuantity: '100', discountRate: '2' },
              { minimumBaseQuantity: '300', discountRate: '4' },
            ],
          },
        },
        { upsert: true },
      ),
      db.collection<{ _id: string }>('settings').updateOne(
        { _id: 'approval' },
        {
          $setOnInsert: {
            orderValueThreshold: '100000000',
            purchaseOrderThreshold: '50000000',
            discountRateThreshold: '15',
          },
        },
        { upsert: true },
      ),
    ]);
    process.stdout.write(
      configuredSecret
        ? `Admin seeded: ${email}\nTOTP secret loaded from environment (value hidden).\n`
        : `Admin seeded: ${email}\nTOTP secret (store securely, shown once): ${secret}\n`,
    );
  } finally {
    await client.close();
  }
}

seed().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
