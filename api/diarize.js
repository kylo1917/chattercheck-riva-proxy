const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081'; // nvidia/parakeet-ctc-riva-1-1b
const SERVER = 'grpc.nvcf.nvidia.com:443';

let cachedRivaProto = null;
function loadRivaProto() {
  if (cachedRivaProto) return cachedRivaProto;
  const packageDefinition = protoLoader.loadSync(
    path.join(__dirname, '..', 'proto/riva/proto/riva_asr.proto'),
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

function recognize({ apiKey, audioBytes, maxSpeakers }) {
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
        encoding: 1, // LINEAR_PCM
        sample_rate_hertz: 16000,
        language_code: 'en-US',
        max_alternatives: 1,
        enable_automatic_punctuation: true,
        diarization_config: {
          enable_speaker_diarization: true,
          max_speaker_count: maxSpeakers || 2,
        },
      },
      audio: audioBytes,
    };
    const deadline = new Date(Date.now() + 25000);
    client.Recognize(request, { deadline }, (err, response) => {
      client.close();
      if (err) return reject(err);
      resolve(response);
    });
  });
}

// Merges consecutive same-speaker words into readable segments.
function toSegments(response) {
  const segments = [];
  let current = null;
  for (const result of response.results || []) {
    const alt = result.alternatives && result.alternatives[0];
    if (!alt || !alt.words) continue;
    for (const w of alt.words) {
      const tag = w.speaker_tag;
      if (!current || current.speaker !== tag) {
        current = { speaker: tag, text: w.word, startMs: Number(w.start_time) };
        segments.push(current);
      } else {
        current.text += ' ' + w.word;
      }
      current.endMs = Number(w.end_time);
    }
  }
  return segments;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { apiKey, audioBase64, maxSpeakers } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'audioBase64 is required' });
    }
    // audioBase64 must be raw 16-bit mono 16kHz PCM (no WAV header), base64-encoded.
    const audioBytes = Buffer.from(audioBase64, 'base64');
    if (audioBytes.length === 0) {
      return res.status(400).json({ error: 'decoded audio is empty' });
    }

    const response = await recognize({ apiKey, audioBytes, maxSpeakers });
    const segments = toSegments(response);
    return res.status(200).json({ segments });
  } catch (err) {
    const code = err && err.code;
    const message = (err && err.message) || String(err);
    // gRPC UNAUTHENTICATED / PERMISSION_DENIED
    if (code === 16 || code === 7) {
      return res.status(401).json({ error: 'NVIDIA API key rejected', detail: message });
    }
    if (code === 8) {
      return res.status(429).json({ error: 'Rate limited by NVIDIA — try again shortly', detail: message });
    }
    console.error('diarize error:', message);
    return res.status(502).json({ error: 'Upstream Riva request failed', detail: message });
  }
};
