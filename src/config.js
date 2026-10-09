// All settings come from environment variables. Anything a vendor or Nikhil has to decide has no default:
// the app refuses to use it until it is set, so nothing is guessed.

export function need(name) {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const opt = (name, fallback = undefined) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

export const num = (name, fallback = undefined) => {
  const v = opt(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
};

export const settings = {
  port: () => num('PORT', 8080),
  // Decision loop
  maxClarify: () => num('MAX_CLARIFY_TURNS', 3),
  minTranscriptChars: () => num('MIN_TRANSCRIPT_CHARS', 60),
  // Scheduling
  scheduleWindowDays: () => num('SCHEDULE_WINDOW_DAYS', 14),
  confirmMaxAttempts: () => num('CONFIRM_MAX_ATTEMPTS', 2),
  timeZone: () => opt('STUDIO_TIME_ZONE', 'Asia/Kolkata'),
  // Cost rates (INR). Left empty means "unknown": amounts are stored as null, never guessed.
  rate: {
    geminiInputPerMTok: () => num('RATE_GEMINI_INPUT_INR_PER_MTOK'),
    geminiOutputPerMTok: () => num('RATE_GEMINI_OUTPUT_INR_PER_MTOK'),
    voicePerMinute: () => num('RATE_VOICE_INR_PER_MINUTE')
  }
};
