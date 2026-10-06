import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import helmet from 'helmet';
import multer from 'multer';

const imageExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const packageColumns = 'id,name,destination,budget,days,highlights,type,image,img,rating,reviews';

function createUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (!imageExtensions.has(file.mimetype)) {
        const error = new Error('Upload a JPEG, PNG, or WebP image.');
        error.status = 400;
        callback(error);
        return;
      }
      callback(null, true);
    },
  });
}

export function createApp({ adminClient, authClientFactory, env = process.env }) {
  const app = express();
  const bucket = env.SUPABASE_STORAGE_BUCKET || 'travel-photos';
  const allowedOrigins = (env.FRONTEND_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({ limit: '32kb' }));

  const requireAdmin = async (req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Admin login required.' });

    const { data: authData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !authData?.user) {
      return res.status(401).json({ error: 'Admin session is invalid or expired.' });
    }

    const { data: adminRecord, error: adminError } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', authData.user.id)
      .maybeSingle();

    if (adminError) return next(adminError);
    if (!adminRecord) return res.status(403).json({ error: 'This account is not an admin.' });
    req.adminUser = authData.user;
    next();
  };

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/api/packages', async (_req, res, next) => {
    const { data, error } = await adminClient
      .from('packages')
      .select(packageColumns)
      .order('id', { ascending: true });
    if (error) return next(error);
    res.json(data);
  });

  app.post(
    '/api/auth/login',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      const email = String(req.body?.email ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const { data, error } = await authClientFactory().auth.signInWithPassword({ email, password });
      if (error || !data?.session || !data?.user) {
        return res.status(401).json({ error: 'Wrong email or password. Please try again.' });
      }

      const { data: adminRecord, error: adminError } = await adminClient
        .from('admin_users')
        .select('user_id')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (adminError) return next(adminError);
      if (!adminRecord) return res.status(403).json({ error: 'This account is not an admin.' });

      res.json({ accessToken: data.session.access_token, expiresAt: data.session.expires_at });
    }
  );

  app.get('/api/auth/session', requireAdmin, (_req, res) => res.json({ valid: true }));

  app.post('/api/packages', requireAdmin, createUploadMiddleware().single('photo'), async (req, res, next) => {
    const name = String(req.body?.name ?? '').trim();
    const destination = String(req.body?.destination ?? '').trim();
    const days = String(req.body?.days ?? '').trim();
    const type = String(req.body?.type ?? '').trim();
    const highlights = String(req.body?.highlights ?? '').trim();
    const budget = Number(req.body?.budget);
    const valid = name.length > 0 && name.length <= 120 &&
      destination.length > 0 && destination.length <= 80 &&
      days.length > 0 && days.length <= 100 &&
      type.length > 0 && type.length <= 80 &&
      highlights.length <= 1200 && Number.isSafeInteger(budget) &&
      budget > 0 && budget <= 10000000;

    if (!valid) return res.status(400).json({ error: 'Check the required fields and price.' });

    let imageUrl = '';
    let imagePath = null;
    if (req.file) {
      const detectedType = await fileTypeFromBuffer(req.file.buffer);
      if (!detectedType || detectedType.mime !== req.file.mimetype || !imageExtensions.has(detectedType.mime)) {
        return res.status(400).json({ error: 'The uploaded file is not a supported image.' });
      }

      imagePath = `${crypto.randomUUID()}${imageExtensions.get(detectedType.mime)}`;
      const { error: uploadError } = await adminClient.storage
        .from(bucket)
        .upload(imagePath, req.file.buffer, {
          contentType: detectedType.mime,
          cacheControl: '3600',
          upsert: false,
        });
      if (uploadError) return next(uploadError);
      imageUrl = adminClient.storage.from(bucket).getPublicUrl(imagePath).data.publicUrl;
    }

    const { data, error } = await adminClient
      .from('packages')
      .insert({ name, destination, budget, days, highlights, type, image: '🧳', img: imageUrl, image_path: imagePath })
      .select(packageColumns)
      .single();

    if (error) {
      if (imagePath) await adminClient.storage.from(bucket).remove([imagePath]);
      return next(error);
    }
    res.status(201).json(data);
  });

  app.delete('/api/packages/:id', requireAdmin, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid package id.' });
    }

    const { data: travelPackage, error: findError } = await adminClient
      .from('packages')
      .select('id,image_path')
      .eq('id', id)
      .maybeSingle();
    if (findError) return next(findError);
    if (!travelPackage) return res.status(404).json({ error: 'Package not found.' });

    const { error: deleteError } = await adminClient.from('packages').delete().eq('id', id);
    if (deleteError) return next(deleteError);
    if (travelPackage.image_path) {
      const { error: storageError } = await adminClient.storage.from(bucket).remove([travelPackage.image_path]);
      if (storageError) console.error('Could not remove package photo:', storageError.message);
    }
    res.status(204).end();
  });

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError || error.status === 400 ? 400 : 500;
    if (status === 500) console.error(error);
    res.status(status).json({
      error: status === 400 ? error.message : 'An unexpected server error occurred.',
    });
  });

  return app;
}