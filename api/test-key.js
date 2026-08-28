const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081'; // nvidia/parakeet-ctc-riva-1-1b
const TDT_FUNCTION_ID = 'd3fe9151-442b-4204-a70d-5fcc597fd610'; // nvidia/parakeet-tdt-0.6b-v2 — candidate replacement, better accuracy on benchmarks
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

// Probes whether the candidate higher-accuracy model (Parakeet TDT 0.6B v2)
// accepts a diarization-enabled request the same way the current model does.
// Uses the same silent clip — this only checks config-level compatibility
// (does the server accept diarization_config for this model), not real
// transcription accuracy, since there's no real audio to send here.
function testTdtDiarization(apiKey) {
  return new Promise((resolve, reject) => {
    const rivaProto = loadRivaProto();
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromMetadataGenerator((_params, callback) => {
        const metadata = new grpc.Metadata();
        metadata.add('function-id', TDT_FUNCTION_ID);
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
        diarization_config: {
          enable_speaker_diarization: true,
          max_speaker_count: 2,
        },
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
  let keyResult;
  try {
    await testKey(apiKey);
    keyResult = { ok: true };
  } catch (err) {
    const code = err && err.code;
    if (code === 16 || code === 7) {
      keyResult = { ok: false, error: 'That key was rejected by NVIDIA — double check it was copied correctly.' };
    } else if (code === 8) {
      keyResult = { ok: false, error: 'Rate limited right now — the key itself looks fine, try again shortly.' };
    } else {
      keyResult = { ok: false, error: (err && err.message) || 'Could not verify the key' };
    }
  }

  // Only bother probing the candidate model if the key itself is good —
  // no point reporting on model compatibility for a rejected key.
  let tdtDiarization = null;
  if (keyResult.ok) {
    try {
      await testTdtDiarization(apiKey);
      tdtDiarization = { ok: true };
    } catch (err) {
      const code = err && err.code;
      tdtDiarization = { ok: false, error: (err && err.message) || `gRPC error code ${code}` };
    }
  }

  return res.status(200).json({ ...keyResult, tdtDiarization });
};
