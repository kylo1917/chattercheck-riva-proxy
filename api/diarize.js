const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Buffer } = require('buffer');
const Busboy = require('busboy');

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
      resolve();
    });
    proc.on('error', reject);
  });
}

// Joins the calibration clip (tutor speaking alone) in front of the actual
// chunk, re-encoding both into a single Ogg/Opus stream so Riva sees one
// continuous recording. Re-encoding (not stream-copy) is required for concat.
async function concatToOgg(calibrationBuffer, chunkBuffer) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const calPath = path.join(tmpDir, `${id}-cal.webm`);
  const chunkPath = path.join(tmpDir, `${id}-chunk.webm`);
  const outPath = path.join(tmpDir, `${id}-out.ogg`);
  await fs.promises.writeFile(calPath, calibrationBuffer);
  await fs.promises.writeFile(chunkPath, chunkBuffer);
  try {
    await runFfmpeg([
      '-y',
      '-i', calPath,
      '-i', chunkPath,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
      '-map', '[out]',
      '-c:a', 'libopus',
      '-f', 'ogg',
      outPath,
    ]);
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(calPath).catch(() => {});
    fs.promises.unlink(chunkPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
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

// Flattens the response into a single word list across all results.
function allWords(response) {
  const words = [];
  for (const result of response.results || []) {
    const alt = result.alternatives && result.alternatives[0];
    if (!alt || !alt.words) continue;
    for (const w of alt.words) {
      words.push({ word: w.word, speaker_tag: w.speaker_tag, startMs: Number(w.start_time), endMs: Number(w.end_time) });
    }
  }
  return words;
}

// Words up to ~calibrationMs belong to the calibration clip. Whichever
// speaker tag dominates that window is the tutor; everything after is
// relabeled tutor/student and re-based to start at 0 for the real chunk.
function splitAndLabel(words, calibrationMs) {
  const tallyBuffer = 400; // ms of slack, generous on purpose — only used to identify the tutor's tag
  const dropBuffer = -150; // when actually cutting the calibration clip out, err toward keeping real speech
  const calWords = words.filter((w) => w.startMs < calibrationMs + tallyBuffer);
  const tally = {};
  for (const w of calWords) tally[w.speaker_tag] = (tally[w.speaker_tag] || 0) + 1;
  let tutorTag = null;
  let best = -1;
  for (const [tag, count] of Object.entries(tally)) {
    if (count > best) { best = count; tutorTag = Number(tag); }
  }

  const segments = [];
  let current = null;
  for (const w of words) {
    if (w.startMs < calibrationMs + dropBuffer) continue; // drop calibration audio itself
    const role = w.speaker_tag === tutorTag ? 'tutor' : 'student';
    const startMs = Math.max(0, w.startMs - calibrationMs);
    const endMs = Math.max(0, w.endMs - calibrationMs);
    if (!current || current.role !== role) {
      current = { role, text: w.word, startMs };
      segments.push(current);
    } else {
      current.text += ' ' + w.word;
    }
    current.endMs = endMs;
  }
  return { segments, tutorTagFound: tutorTag !== null };
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers });
    } catch (e) {
      return reject(e);
    }
    const parts = {};
    bb.on('file', (name, stream) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        parts[name] = Buffer.concat(chunks);
      });
    });
    bb.on('field', (name, value) => {
      parts[name] = value;
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve(parts));
    req.pipe(bb);
  });
}

const ALLOWED_ORIGINS = new Set([
  'https://kylo1917.github.io',
]);

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nvidia-Api-Key, X-Max-Speakers, X-Calibration-Duration-Ms');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const apiKey = req.headers['x-nvidia-api-key'];
    const maxSpeakers = parseInt(req.headers['x-max-speakers'], 10) || 2;
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'X-Nvidia-Api-Key header is required' });
    }

    const parts = await readMultipart(req);
    const calibration = parts.calibration;
    const chunk = parts.chunk;
    if (!calibration || !calibration.length) return res.status(400).json({ error: "missing 'calibration' part" });
    if (!chunk || !chunk.length) return res.status(400).json({ error: "missing 'chunk' part" });

    const calibrationMsHeader = parseInt(req.headers['x-calibration-duration-ms'], 10);
    if (!calibrationMsHeader) {
      return res.status(400).json({ error: 'X-Calibration-Duration-Ms header is required' });
    }

    const oggBuffer = await concatToOgg(calibration, chunk);
    const response = await recognize({ apiKey, audioBytes: oggBuffer, maxSpeakers });
    const words = allWords(response);
    const { segments, tutorTagFound } = splitAndLabel(words, calibrationMsHeader);

    return res.status(200).json({ segments, tutorTagFound });
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
