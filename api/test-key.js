const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081'; // nvidia/parakeet-ctc-riva-1-1b
const SERVER = 'grpc.nvcf.nvidia.com:443';

// A ~1s silent Ogg/Opus clip, embedded so this endpoint needs no audio from
// the caller — it exists purely to check whether an API key actually works.
const SILENT_OGG_B64 = 'T2dnUwACAAAAAAAAAADoRm9RAAAAAMh31voBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAOhGb1EBAAAApPDDzAE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAAOhGb1ECAAAABYGNGTIICQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICEgL5ME27MWASAfJcifhROpQSAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfAT2dnUwAEuLwAAAAAAADoRm9RAwAAAE41bucBCEgHyXnIyVfA';

let cachedRivaProto = null;
function loadRivaProto() {
  if (cachedRivaProto) return cachedRivaProto;
  const packageDefinition = protoLoader.loadSync(
    path.join(__dirname, '..', 'proto', 'riva', 'proto', 'riva_asr.proto'),
    {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [path.join(__dirname, '..', 'proto')],
    }
  );
  cachedRivaProto = grpc.loadPackageDefinition(packageDefinition).nvidia.riva.asr;
  return cachedRivaProto;
}

function testKey(apiKey) {
  return new Promise((resolve, reject) => {
    const rivaProto = loadRivaProto();
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromMetadataGenerator((_params, callback) => {
        const metadata = new grpc.Metadata();
        metadata.add('function-id', FUNCTION_ID);
        metadata.add('authorization', `Bearer ${apiKey}`);
        callback(null, metadata);
      })
    );
    const client = new rivaProto.RivaSpeechRecognition(SERVER, creds);
    const request = {
      config: {
        encoding: 4, // OGGOPUS
        sample_rate_hertz: 48000,
        language_code: 'en-US',
        max_alternatives: 1,
      },
      audio: Buffer.from(SILENT_OGG_B64, 'base64'),
    };
    const deadline = new Date(Date.now() + 15000);
    client.Recognize(request, { deadline }, (err) => {
      client.close();
      if (err) return reject(err);
      resolve();
    });
  });
}

const { enforceOrigin, rateLimited } = require('./_shared');

module.exports = async (req, res) => {
  if (!enforceOrigin(req, res)) return;
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Nvidia-Api-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (rateLimited(req)) return res.status(429).json({ ok: false, error: 'Too many requests — slow down a little' });

  const apiKey = req.headers['x-nvidia-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'X-Nvidia-Api-Key header is required' });
  }
  try {
    await testKey(apiKey);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const code = err && err.code;
    if (code === 16 || code === 7) {
      return res.status(200).json({ ok: false, error: 'That key was rejected by NVIDIA — double check it was copied correctly.' });
    }
    if (code === 8) {
      return res.status(200).json({ ok: false, error: 'Rate limited right now — the key itself looks fine, try again shortly.' });
    }
    return res.status(200).json({ ok: false, error: (err && err.message) || 'Could not verify the key' });
  }
};
