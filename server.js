// BH API Server — espeak-ng IPA conversion + Claude API proxy
// Deployed on Google Cloud Run (free tier)
// All diagnostics built in from day one.

const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || '';
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
    googleTTS: {
      keyConfigured: GOOGLE_TTS_KEY.length > 0
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

// ---------- TTS — IPA to espeak-ng Kirshenbaum mapping ----------
// Tested 41/41 pass with French voice base (Session 22)
const IPA_TO_ESPEAK = {
  't':'t','k':'k','r':'r','v':'v','s':'s','l':'l','p':'p','b':'b','d':'d',
  '\u0261':'g','g':'g','n':'n','m':'m','j':'j','h':'h','w':'w','q':'q','x':'x',
  '\u0288':'t`','\u0256':'d`','\u00e7':'C','\u0292':'Z','\u0294':'?',
  'f':'f','z':'z','\u0283':'S','\u03b8':'T','\u00f0':'D',
  '\u0263':'Q','\u026c':'l!','\u0295':'?\\','\u0127':'h\\',
  '\u0278':'p\\','\u0282':'s`',
  'a':'a','e':'e','i':'i','o':'o','y':'y','u':'u',
  '\u0251':'A','\u025b':'E','\u0254':'O','\u028a':'U',
  '\u00e6':'{','\u0259':'@','\u026a':'I',
  '\u02c8':"'",'\\u02cc':',','\u02d0':':',
};

function ipaToEspeak(ipaStr) {
  const result = [];
  let i = 0;
  while (i < ipaStr.length) {
    const ch = ipaStr[i];
    if (i + 1 < ipaStr.length && ipaStr[i + 1] === '\u0303') {
      const base = IPA_TO_ESPEAK[ch] || ch;
      result.push(base + '~');
      i += 2;
      continue;
    }
    const mapped = IPA_TO_ESPEAK[ch];
    if (mapped !== undefined) result.push(mapped);
    i++;
  }
  return result.join('');
}

// Earth TTS — Google Cloud TTS API
app.get('/api/tts', async (req, res) => {
  const { text, lang } = req.query;
  if (!text || !lang) return res.status(400).json({ error: 'text and lang required' });
  if (!GOOGLE_TTS_KEY) return res.status(503).json({ error: 'GOOGLE_TTS_KEY not configured' });

  const langMap = {
    'ar':'ar-XA','fr':'fr-FR','en':'en-US','es':'es-ES','de':'de-DE',
    'ja':'ja-JP','ko':'ko-KR','hi':'hi-IN','ru':'ru-RU','zh':'cmn-CN',
    'tr':'tr-TR','it':'it-IT','pt':'pt-BR','nl':'nl-NL','pl':'pl-PL',
    'sv':'sv-SE','da':'da-DK','fi':'fi-FI','nb':'nb-NO','el':'el-GR',
    'he':'he-IL','id':'id-ID','ms':'ms-MY','th':'th-TH','vi':'vi-VN',
    'uk':'uk-UA','cs':'cs-CZ','ro':'ro-RO','hu':'hu-HU','sk':'sk-SK',
    'bg':'bg-BG','hr':'hr-HR','sr':'sr-RS','cy':'cy-GB','ca':'ca-ES',
    'fil':'fil-PH','ta':'ta-IN','te':'te-IN','ml':'ml-IN','kn':'kn-IN',
    'gu':'gu-IN','bn':'bn-IN','mr':'mr-IN','pa':'pa-IN','ur':'ur-IN',
    'af':'af-ZA','sw':'sw-KE','is':'is-IS','lv':'lv-LV','lt':'lt-LT',
    'et':'et-EE',
  };
  const googleLang = langMap[lang] || lang;

  const start = Date.now();
  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: googleLang, ssmlGender: 'NEUTRAL' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9, pitch: 0 }
        })
      }
    );
    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[TTS] Google API error ${response.status}: ${errBody.substring(0, 300)}`);
      return res.status(response.status).json({ error: 'Google TTS API error', status: response.status, detail: errBody.substring(0, 300) });
    }
    const data = await response.json();
    if (!data.audioContent) return res.status(500).json({ error: 'No audio content in response' });
    res.json({ audioContent: data.audioContent, encoding: 'mp3', lang: googleLang, charCount: text.length, duration: `${Date.now() - start}ms` });
  } catch (e) {
    console.error(`[TTS] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// BH TTS — espeak-ng with French voice + Kirshenbaum notation
app.get('/api/tts-bh', async (req, res) => {
  const { ipa } = req.query;
  if (!ipa) return res.status(400).json({ error: 'ipa parameter required' });

  // Try Google Cloud TTS with SSML phoneme tag first (neural quality)
  if (GOOGLE_TTS_KEY) {
    try {
      const ssml = `<speak><phoneme alphabet="ipa" ph="${ipa}">${ipa}</phoneme></speak>`;
      const response = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { ssml },
            voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
            audioConfig: { audioEncoding: 'MP3', speakingRate: 0.85, pitch: -1.0 }
          })
        }
      );
      if (response.ok) {
        const data = await response.json();
        if (data.audioContent) {
          return res.json({ audioContent: data.audioContent, encoding: 'mp3', inputIPA: ipa, engine: 'google-ssml', voice: 'en-US' });
        }
      }
      // If Google fails, log and fall through to espeak-ng
      const errText = await response.text().catch(() => '');
      console.warn(`[TTS-BH] Google SSML failed (${response.status}), falling back to espeak-ng: ${errText.substring(0, 200)}`);
    } catch (e) {
      console.warn(`[TTS-BH] Google SSML error, falling back to espeak-ng: ${e.message}`);
    }
  }

  // Fallback: espeak-ng with French voice + Kirshenbaum notation
  const espeakPhon = ipaToEspeak(ipa);
  if (!espeakPhon || espeakPhon.length === 0) {
    return res.status(400).json({ error: 'No mappable phonemes found', input: ipa, mapped: espeakPhon });
  }

  try {
    const tmpFile = `/tmp/bh_tts_${Date.now()}.wav`;
    execSync(`espeak-ng -v fr "[[${espeakPhon}]]" -w ${tmpFile} -s 120`, { encoding: 'utf-8', timeout: 10000 });
    if (!fs.existsSync(tmpFile)) return res.status(500).json({ error: 'Audio file not generated' });
    const audioBuffer = fs.readFileSync(tmpFile);
    const audioBase64 = audioBuffer.toString('base64');
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    res.json({ audioContent: audioBase64, encoding: 'wav', inputIPA: ipa, espeakPhon, engine: 'espeak-ng', voice: 'fr', size: audioBuffer.length });
  } catch (e) {
    console.error(`[TTS-BH] espeak-ng error: ${e.message}`);
    res.status(500).json({ error: e.message, inputIPA: ipa, espeakPhon });
  }
});

// ---------- 404 HANDLER ----------

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      'GET  /api/health        — server status',
      'GET  /api/diagnostics   — test all languages',
      'GET  /api/languages     — list all languages',
      'GET  /api/ipa?word=X&lang=Y — IPA conversion',
      'GET  /api/tts?text=X&lang=Y — Earth voice (Google Cloud TTS)',
      'GET  /api/tts-bh?ipa=X  — BH voice (espeak-ng Kirshenbaum)',
      'POST /api/claude-brain  — translate mode proxy',
      'POST /api/claude-verify — reverse verification'
    ]
  });
});

// ---------- START ----------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[START] BH API server listening on port ${PORT}`);
  console.log(`[START] espeak-ng: ${espeakStatus} (${espeakVersion})`);
  console.log(`[START] Claude API key: ${ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`[START] Google TTS key: ${GOOGLE_TTS_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`[START] CORS origin: ${ALLOWED_ORIGIN}`);
});
