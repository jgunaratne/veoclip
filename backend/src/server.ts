import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { apiRouter } from './routes/api.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8080;
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

// ---------------------------------------------------------------------------
// Ensure data directories exist
// ---------------------------------------------------------------------------

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// CORS — allow the Next.js dev server
app.use(
  cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// JSON body parsing (for non-multipart requests)
app.use(express.json({ limit: '10mb' }));

// Serve generated media files
app.use('/media', express.static(path.resolve(OUTPUT_DIR)));

// Serve uploaded images
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// API routes
app.use('/api', apiRouter);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n🎬 VeoClip backend running at http://localhost:${PORT}`);
  console.log(`   Uploads:  ${path.resolve(UPLOAD_DIR)}`);
  console.log(`   Output:   ${path.resolve(OUTPUT_DIR)}`);
  console.log();
});
