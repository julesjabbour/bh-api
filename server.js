// BH API Server — espeak-ng IPA conversion + Claude API proxy
// Deployed on Google Cloud Run (free tier)
// All diagnostics built in from day one.

const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const startTime = Date.now();

// ---------- MIDDLEWARE ----------

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '50kb' }));

// Request logging with timing
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const color = status < 400 ? '\x1b[32m' : '\x1b[31m';
    console.log(`${color}${req.method} ${req.path} ${status} ${duration}ms\x1b[0m`);
  });
  next();
});

// ---------- STARTUP DIAGNOSTICS ----------

let espeakVersion = 'unknown';
let espeakStatus = 'unchecked';
let espeakLanguages = [];

try {
  espeakVersion = execSync('espeak-ng --version', { encoding: 'utf-8' }).trim();
  espeakStatus = 'ok';
  console.log(`[BOOT] espeak-ng: ${espeakVersion}`);
} catch (e) {
  espeakStatus = 'missing';
  console.error(`[BOOT] espeak-ng NOT FOUND: ${e.message}`);
}

// Get available languages
try {
  const voices = execSync('espeak-ng --voices', { encoding: 'utf-8' });
  espeakLanguages = voices.split('\n')
    .slice(1) // skip header
    .filter(line => line.trim())
    .map(line => {
      const parts = line.trim().split(/\s+/);
      return { language: parts[1], name: parts[3] };
    });
  console.log(`[BOOT] ${espeakLanguages.length} voices available`);
} catch (e) {
  console.error(`[BOOT] Could not list voices: ${e.message}`);
}

// ---------- API ROUTES ----------

// Language list — all 130+ languages espeak-ng supports
app.get('/api/languages', (req, res) => {
  const langs = espeakLanguages.map(v => ({
    code: v.language,
    name: v.name.replace(/_/g, ' ')
  }));
  // Add universal as first option
  langs.unshift({ code: 'universal', name: 'Universal (cardinal vowels)' });
  res.json({ count: langs.length, languages: langs });
});

// Health check — Cloud Run pings this
app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const mem = process.memoryUsage();
  res.json({
    status: espeakStatus === 'ok' ? 'healthy' : 'degraded',
    espeak: {
      status: espeakStatus,
      version: espeakVersion,
      voiceCount: espeakLanguages.length
    },
    claude: {
      keyConfigured: ANTHROPIC_API_KEY.length > 0,
      keyLength: ANTHROPIC_API_KEY.length
    },
    uptime: `${uptime}s`,
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString()
  });
});

// Diagnostics — tests espeak-ng with multiple scripts
app.get('/api/diagnostics', async (req, res) => {
  const testWords = [
    { word: 'hello', lang: 'en', script: 'Latin', expected: true },
    { word: 'bonjour', lang: 'fr', script: 'Latin', expected: true },
    { word: 'danke', lang: 'de', script: 'Latin', expected: true },
    { word: 'مرحبا', lang: 'ar', script: 'Arabic', expected: true },
    { word: 'नमस्ते', lang: 'hi', script: 'Devanagari', expected: true },
    { word: '안녕하세요', lang: 'ko', script: 'Korean', expected: true },
    { word: 'こんにちは', lang: 'ja', script: 'Japanese', expected: true },
    { word: 'здравствуйте', lang: 'ru', script: 'Cyrillic', expected: true },
    { word: 'Ṭareka', lang: 'en', script: 'BH-Latin', expected: true },
    { word: 'Çarezha', lang: 'en', script: 'BH-Latin', expected: true }
  ];

  const results = [];
  for (const test of testWords) {
    const start = Date.now();
    try {
      const ipa = execSync(
        `espeak-ng -q --ipa -v ${test.lang} "${test.word}"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim().replace(/_/g, ' ');
      
      const duration = Date.now() - start;
      const isEmpty = !ipa || ipa.length === 0;
      const isGarbage = /[\ufffd\u0000-\u001f]/.test(ipa);
      
      results.push({
        word: test.word,
        lang: test.lang,
        script: test.script,
        ipa: ipa,
        status: isEmpty ? 'empty' : isGarbage ? 'garbage' : 'pass',
        duration: `${duration}ms`
      });
    } catch (e) {
      results.push({
        word: test.word,
        lang: test.lang,
        script: test.script,
        ipa: null,
        status: 'error',
        error: e.message.substring(0, 200),
        duration: `${Date.now() - start}ms`
      });
    }
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const total = results.length;

  res.json({
    summary: `${passed}/${total} passed`,
    espeak: { version: espeakVersion, status: espeakStatus },
    results
  });
});

// IPA conversion — the core endpoint
app.get('/api/ipa', (req, res) => {
  const { word, lang } = req.query;

  // Validation
  if (!word || !lang) {
    return res.status(400).json({
      error: 'word and lang required',
      diagnostic: { step: 'validation', detail: `word=${!!word}, lang=${!!lang}` }
    });
  }

  if (word.length > 200) {
    return res.status(400).json({
      error: 'word too long (max 200 chars)',
      diagnostic: { step: 'validation', detail: `length=${word.length}` }
    });
  }

  if (espeakStatus !== 'ok') {
    return res.status(503).json({
      error: 'espeak-ng not available',
      diagnostic: { step: 'espeak_check', status: espeakStatus, version: espeakVersion }
    });
  }

  // Sanitize word for shell (prevent injection)
  const safeWord = word.replace(/["`$\\]/g, '');
  const safeLang = lang.replace(/[^a-zA-Z0-9\-_]/g, '');

  const start = Date.now();
  try {
    const raw = execSync(
      `espeak-ng -q --ipa -v ${safeLang} "${safeWord}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    const ipa = raw.replace(/_/g, ' ');
    const duration = Date.now() - start;

    res.json({
      word,
      lang: safeLang,
      ipa,
      diagnostic: {
        step: 'complete',
        rawOutput: raw,
        duration: `${duration}ms`,
        ipaLength: ipa.length,
        method: 'espeak-ng-native'
      }
    });
  } catch (e) {
    const duration = Date.now() - start;
    res.status(500).json({
      error: `espeak-ng failed: ${e.message.substring(0, 200)}`,
      word,
      lang: safeLang,
      diagnostic: {
        step: 'espeak_exec',
        duration: `${duration}ms`,
        exitCode: e.status,
        stderr: e.stderr ? e.stderr.toString().substring(0, 200) : null
      }
    });
  }
});

// Claude API proxy — translate mode (brain)
app.post('/api/claude-brain', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'Claude API key not configured',
      diagnostic: { step: 'key_check', configured: false }
    });
  }

  const { prompt, systemPrompt, maxTokens } = req.body;
  if (!prompt) {
    return res.status(400).json({
      error: 'prompt required',
      diagnostic: { step: 'validation' }
    });
  }

  const start = Date.now();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens || 4000,
        system: systemPrompt || undefined,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const duration = Date.now() - start;

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json({
        error: `Claude API returned ${response.status}`,
        diagnostic: {
          step: 'claude_response',
          status: response.status,
          body: errorBody.substring(0, 500),
          duration: `${duration}ms`
        }
      });
    }

    const data = await response.json();
    res.json({
      content: data.content,
      diagnostic: {
        step: 'complete',
        duration: `${duration}ms`,
        model: data.model,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens
      }
    });
  } catch (e) {
    res.status(500).json({
      error: `Claude API call failed: ${e.message}`,
      diagnostic: {
        step: 'claude_fetch',
        duration: `${Date.now() - start}ms`,
        errorType: e.constructor.name
      }
    });
  }
});

// Claude API proxy — reverse verification
app.post('/api/claude-verify', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Claude API key not configured' });
  }

  const { prompt, maxTokens } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const start = Date.now();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens || 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json({
        error: `Claude API returned ${response.status}`,
        diagnostic: { status: response.status, body: errorBody.substring(0, 500) }
      });
    }

    const data = await response.json();
    const text = data.content?.map(b => b.type === 'text' ? b.text : '').join('') || '';
    res.json({
      text,
      diagnostic: { duration: `${Date.now() - start}ms`, model: data.model }
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      diagnostic: { duration: `${Date.now() - start}ms` }
    });
  }
});

// ---------- 404 HANDLER ----------

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      'GET  /api/health       — server status',
      'GET  /api/diagnostics  — test all languages',
      'GET  /api/ipa?word=X&lang=Y — IPA conversion',
      'POST /api/claude-brain — translate mode proxy',
      'POST /api/claude-verify — reverse verification'
    ]
  });
});

// ---------- START ----------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[START] BH API server listening on port ${PORT}`);
  console.log(`[START] espeak-ng: ${espeakStatus} (${espeakVersion})`);
  console.log(`[START] Claude API key: ${ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`[START] CORS origin: ${ALLOWED_ORIGIN}`);
});
