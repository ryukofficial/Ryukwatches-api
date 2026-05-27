const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GOGO_BASES = [
  'https://anitaku.pe',
  'https://gogoanime3.co',
  'https://gogoanimes.fi',
];

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://anitaku.pe/',
};

async function fetchGogo(path) {
  for (const base of GOGO_BASES) {
    try {
      const res = await axios.get(base + path, { headers, timeout: 10000 });
      if (res.status === 200) return { data: res.data, base };
    } catch {}
  }
  throw new Error('All Gogoanime mirrors failed');
}

// Search Gogoanime and return the best matching gogoId for a title.
// Tries exact slug match first, then first result fallback.
async function searchGogoId(title) {
  const { data } = await fetchGogo(`/search.html?keyword=${encodeURIComponent(title)}`);
  const $ = cheerio.load(data);

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let bestId = null;
  let firstId = null;

  $('ul.items li').each((_, el) => {
    const href = $(el).find('.name a').attr('href') || '';
    const id = href.replace('/category/', '').replace(/\/$/, '');
    if (!id) return;
    if (!firstId) firstId = id;
    // prefer exact slug match or close match
    if (!bestId && (id === slug || id.startsWith(slug))) bestId = id;
  });

  return bestId || firstId;
}

// Fetch the real episode list + total from Gogoanime ajax endpoint.
// This is always up to date — no Jikan involvement.
async function fetchAnimeInfo(gogoId) {
  const { data } = await fetchGogo(`/category/${gogoId}`);
  const $ = cheerio.load(data);

  const title    = $('div.anime_info_body_bg h1').text().trim();
  const image    = $('div.anime_info_body_bg img').attr('src');
  const synopsis = $('div.description').text().trim();
  const animeId  = $('#movie_id').val();
  const alias    = $('#alias_anime').val();

  // Collect all episode ranges from the pagination tabs
  let epStart = 0;
  let epEnd   = 0;
  $('#episode_page a').each((_, el) => {
    const s = parseInt($(el).attr('ep_start')) || 0;
    const e = parseInt($(el).attr('ep_end'))   || 0;
    if (s < epStart || epStart === 0) epStart = s;
    if (e > epEnd) epEnd = e;
  });

  let episodes   = [];
  let actualTotal = epEnd;

  if (animeId && epEnd > 0) {
    try {
      const epRes = await axios.get(
        `https://ajax.gogocdn.net/ajax/load-list-episode` +
        `?ep_start=${epStart}&ep_end=${epEnd}&id=${animeId}&default_ep=0&alias=${alias}`,
        { headers, timeout: 10000 }
      );
      const $ep = cheerio.load(epRes.data);
      $ep('li').each((_, el) => {
        const href = $ep(el).find('a').attr('href')?.trim() || '';
        const num  = $ep(el).find('.name').text().replace('EP', '').trim();
        if (href) {
          episodes.push({
            id:     href.replace(/^\//, ''),
            number: parseFloat(num) || 0,
          });
        }
      });
      // Ajax returns newest-first; reverse to ascending
      episodes.reverse();

      if (episodes.length > 0) {
        actualTotal = Math.max(...episodes.map(e => e.number));
      }
    } catch (err) {
      console.error('Episode ajax error:', err.message);
    }
  }

  return {
    id: gogoId,
    title,
    image,
    synopsis,
    totalEpisodes: actualTotal,
    episodes,
  };
}

// ── GET / ── health
app.get('/', (req, res) => res.json({ status: 'RyukWatches API', version: '2.0.0' }));

// ── GET /anime/search?q= ──
app.get('/anime/search', async (req, res) => {
  try {
    const q    = req.query.q || '';
    const page = req.query.page || 1;
    const { data } = await fetchGogo(`/search.html?keyword=${encodeURIComponent(q)}&page=${page}`);
    const $ = cheerio.load(data);
    const results = [];
    $('ul.items li').each((_, el) => {
      const a    = $(el).find('.name a');
      const img  = $(el).find('img').attr('src');
      const href = a.attr('href') || '';
      results.push({
        id:       href.replace('/category/', '').replace(/\/$/, ''),
        title:    a.text().trim(),
        image:    img,
        released: $(el).find('.released').text().replace('Released:', '').trim(),
      });
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/info/:gogoId ──
app.get('/anime/info/:id', async (req, res) => {
  try {
    res.json(await fetchAnimeInfo(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/episodes/mal/:malId ──
// Primary endpoint the frontend calls for episode list.
// title query param avoids a Jikan call when already known.
app.get('/anime/episodes/mal/:malId', async (req, res) => {
  try {
    const malId = req.params.malId;
    // title comes in already decoded from frontend — don't double-decode
    let title = req.query.title ? decodeURIComponent(req.query.title) : '';

    if (!title) {
      // Only use Jikan for title string — never for episode data
      try {
        const jk = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`, { timeout: 8000 });
        title = jk.data.data?.title_english || jk.data.data?.title || '';
      } catch {
        return res.status(500).json({ error: 'Could not resolve title' });
      }
    }

    const gogoId = await searchGogoId(title);
    if (!gogoId) return res.status(404).json({ error: `Anime "${title}" not found on Gogoanime` });

    const info = await fetchAnimeInfo(gogoId);
    res.json({ ...info, gogoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/mal/:malId/:ep ──
// Stream URL by MAL id + episode number via gogoanime.me.uk player
app.get('/anime/stream/mal/:malId/:ep', async (req, res) => {
  try {
    const { malId, ep } = req.params;
    const category = req.query.category || 'sub';

    const playerUrl = `https://gogoanime.me.uk/newplayer.php?mal_id=${malId}&ep=${ep}&category=${category}`;
    const playerRes = await axios.get(playerUrl, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      timeout: 10000,
      maxRedirects: 5,
    });

    const $p = cheerio.load(playerRes.data);
    const iframeSrc = $p('iframe').attr('src') || '';
    const scripts   = $p('script').map((_, el) => $p(el).html()).get().join('\n');
    const m3u8      = [...new Set(scripts.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g) || [])];

    res.json({ malId, ep, category, playerUrl, iframeSrc, m3u8 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/:episodeId ──
// Stream URL by Gogoanime episode slug (e.g. one-piece-episode-1163)
app.get('/anime/stream/:episodeId', async (req, res) => {
  try {
    const { data, base } = await fetchGogo(`/${req.params.episodeId}`);
    const $ = cheerio.load(data);

    const iframeSrc = $('div.play-video iframe').attr('src');
    if (!iframeSrc) return res.status(404).json({ error: 'No stream found' });

    const embedRes = await axios.get(iframeSrc, {
      headers: { ...headers, Referer: base + '/' },
      timeout: 8000,
    });
    const $e    = cheerio.load(embedRes.data);
    const scripts = $e('script').map((_, el) => $e(el).html()).get().join('\n');
    const m3u8  = [...new Set(scripts.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g) || [])];

    res.json({ episodeId: req.params.episodeId, iframeSrc, m3u8, embedUrl: iframeSrc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy/m3u8 ── Proxy + rewrite segment URLs to avoid CORS
app.get('/proxy/m3u8', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url || '');
    if (!url.includes('.m3u8')) return res.status(400).json({ error: 'Not an m3u8 URL' });

    const response = await axios.get(url, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      responseType: 'text',
      timeout: 8000,
    });

    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const rewritten = response.data.replace(/^(?!#)([^\n\r]+)$/gm, (line) => {
      const t = line.trim();
      if (!t) return line;
      const abs = t.startsWith('http') ? t : baseUrl + t;
      return abs.includes('.m3u8')
        ? `/proxy/m3u8?url=${encodeURIComponent(abs)}`
        : `/proxy/ts?url=${encodeURIComponent(abs)}`;
    });

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy/ts ── Proxy video segments
app.get('/proxy/ts', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url || '');
    const response = await axios.get(url, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      responseType: 'arraybuffer',
      timeout: 20000,
    });
    res.set('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /debug/mal/:malId ── shows every step so we can diagnose issues
app.get('/debug/mal/:malId', async (req, res) => {
  const log = [];
  try {
    const malId = req.params.malId;
    const title = req.query.title ? decodeURIComponent(req.query.title) : '';
    log.push({ step: 1, msg: 'Start', malId, title });

    // Step 1: title lookup
    let resolvedTitle = title;
    if (!resolvedTitle) {
      try {
        const jk = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`, { timeout: 8000 });
        resolvedTitle = jk.data.data?.title_english || jk.data.data?.title || '';
        log.push({ step: 2, msg: 'Jikan title', resolvedTitle });
      } catch(e) {
        log.push({ step: 2, msg: 'Jikan failed', error: e.message });
      }
    }

    // Step 2: gogo search
    let gogoId = null;
    try {
      gogoId = await searchGogoId(resolvedTitle);
      log.push({ step: 3, msg: 'Gogo search', gogoId });
    } catch(e) {
      log.push({ step: 3, msg: 'Gogo search failed', error: e.message });
    }

    if (!gogoId) return res.json({ success: false, log });

    // Step 3: fetch category page
    let epRanges = [], animeId = null, alias = null;
    try {
      const { data } = await fetchGogo(`/category/${gogoId}`);
      const $ = cheerio.load(data);
      animeId = $('#movie_id').val();
      alias   = $('#alias_anime').val();
      $('#episode_page a').each((_, el) => {
        epRanges.push({ start: $(el).attr('ep_start'), end: $(el).attr('ep_end') });
      });
      log.push({ step: 4, msg: 'Category page', animeId, alias, epRanges });
    } catch(e) {
      log.push({ step: 4, msg: 'Category page failed', error: e.message });
    }

    // Step 4: ajax episode list
    if (animeId && epRanges.length) {
      const epStart = Math.min(...epRanges.map(r => parseInt(r.start) || 0));
      const epEnd   = Math.max(...epRanges.map(r => parseInt(r.end) || 0));
      try {
        const epRes = await axios.get(
          `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${animeId}&default_ep=0&alias=${alias}`,
          { headers, timeout: 10000 }
        );
        const $ep = cheerio.load(epRes.data);
        const count = $ep('li').length;
        const first = $ep('li').last().find('.name').text().trim();
        const last  = $ep('li').first().find('.name').text().trim();
        log.push({ step: 5, msg: 'Ajax episodes', count, firstEp: first, latestEp: last, epStart, epEnd });
      } catch(e) {
        log.push({ step: 5, msg: 'Ajax failed', error: e.message });
      }
    }

    res.json({ success: true, log });
  } catch(e) {
    res.json({ success: false, error: e.message, log });
  }
});

app.listen(PORT, () => console.log(`RyukWatches API v2.0 on port ${PORT}`));
