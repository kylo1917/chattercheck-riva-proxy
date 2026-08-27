# chattercheck-riva-proxy

Stateless serverless proxy that forwards audio to NVIDIA Riva ASR (with speaker diarization)
and returns speaker-labeled transcript segments.

Nothing is stored or logged — the caller's NVIDIA API key is passed per-request and used only
to authenticate that single call.

## POST /api/diarize

Body (JSON):
- `apiKey` (string, required) — caller's NVIDIA API key
- `audioBase64` (string, required) — raw 16-bit mono 16kHz PCM audio, base64-encoded (no WAV header)
- `maxSpeakers` (number, optional, default 2)

Response:
```json
{ "segments": [{ "speaker": 0, "text": "...", "startMs": 0, "endMs": 880 }] }
```
