const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081'; // nvidia/parakeet-ctc-riva-1-1b
const SERVER = 'grpc.nvcf.nvidia.com:443';

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

// Remuxes WebM/Opus (what MediaRecorder produces in the browser) into an
// Ogg/Opus container (what Riva's OGGOPUS encoding expects). Stream copy only
// — no re-encoding, so it's fast and lossless.
function remuxWebmToOgg(webmBuffer) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const id = crypto.randomBytes(8).toString('hex');
    const inPath = path.join(tmpDir, `${id}.webm`);
    const outPath = path.join(tmpDir, `${id}.ogg`);
    fs.writeFile(inPath, webmBuffer, (writeErr) => {
      if (writeErr) return reject(writeErr);
      const proc = spawn(ffmpegPath, ['-y', '-i', inPath, '-c:a', 'copy', '-f', 'ogg', outPath]);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', (code) => {
        fs.unlink(inPath, () => {});
        if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        fs.readFile(outPath, (readErr, oggBuffer) => {
          fs.unlink(outPath, () => {});
          if (readErr) return reject(readErr);
          resolve(oggBuffer);
        });
      });
      proc.on('error', reject);
    });
  });
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
        encoding: 4, // OGGOPUS
        sample_rate_hertz: 48000,
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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nvidia-Api-Key, X-Max-Speakers');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const apiKey = req.headers['x-nvidia-api-key'];
    const maxSpeakers = parseInt(req.headers['x-max-speakers'], 10) || 2;
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'X-Nvidia-Api-Key header is required' });
    }

    const webmBuffer = Buffer.isBuffer(req.body) ? req.body : await readRawBody(req);
    if (!webmBuffer || webmBuffer.length === 0) {
      return res.status(400).json({ error: 'empty audio body' });
    }

    const oggBuffer = await remuxWebmToOgg(webmBuffer);
    const response = await recognize({ apiKey, audioBytes: oggBuffer, maxSpeakers });
    const segments = toSegments(response);
    return res.status(200).json({ segments });
  } catch (err) {
    const code = err && err.code;
    const message = (err && err.message) || String(err);
    if (code === 16 || code === 7) {
      return res.status(401).json({ error: 'NVIDIA API key rejected', detail: message });
    }
    if (code === 8) {
      return res.status(429).json({ error: 'Rate limited by NVIDIA — try again shortly', detail: message });
    }
    console.error('diarize error:', message);
    return res.status(502).json({ error: 'Upstream request failed', detail: message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
