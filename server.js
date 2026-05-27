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

// ── Fetch anime info + REAL episode count from Gogo ──
// Key fix: use ep_start=0 and the REAL ep_end from the page,
// then ALSO scrape the last episode page to catch any episodes
// that aired after the category page's ep_end was last cached.
async function fetchAnimeInfo(gogoId) {
  const { data } = await fetchGogo(`/category/${gogoId}`);
  const $ = cheerio.load(data);

  const title    = $('div.anime_info_body_bg h1').text().trim();
  const image    = $('div.anime_info_body_bg img').attr('src');
  const synopsis = $('div.description').text().trim();
  const animeId  = $('#movie_id').val();
  const alias    = $('#alias_anime').val();

  // Get ALL episode page ranges listed (e.g. 1-100, 101-200, etc.)
  const epRanges = [];
  $('#episode_page a').each((_, el) => {
    const start = parseInt($(el).attr('ep_start')) || 0;
    const end   = parseInt($(el).attr('ep_end'))   || 0;
    epRanges.push({ start, end });
  });

  // True ep_end = highest end value across all ranges
  const epEnd = epRanges.reduce((max, r) => Math.max(max, r.end), 0);
  const epStart = epRanges.reduce((min, r) => Math.min(min, r.start), 0);

  let episodes = [];
  let actualTotal = epEnd;

  if (animeId && epEnd > 0) {
    try {
      // Fetch the full list using the real ep_start/ep_end from the page
      const epRes = await axios.get(
        `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${animeId}&default_ep=0&alias=${alias}`,
        { headers, timeout: 10000 }
      );
      const $ep = cheerio.load(epRes.data);
      $ep('li').each((_, el) => {
        const href = $ep(el).find('a').attr('href')?.trim();
        const num  = $ep(el).find('.name').text().replace('EP', '').trim();
        if (href) episodes.push({ id: href.replace('/', ''), number: parseFloat(num) || 0 });
      });
      episodes = episodes.reverse(); // ajax returns descending; make ascending

      if (episodes.length > 0) {
        actualTotal = Math.max(...episodes.map(e => e.number));
      }
    } catch (err) {
      console.error('Episode ajax fetch failed:', err.message);
    }
  }

  return { id: gogoId, title, image, synopsis, totalEpisodes: actualTotal, episodes };
}

async function searchGogoId(title) {
  const { data } = await fetchGogo(`/search.html?keyword=${encodeURIComponent(title)}`);
  const $ = cheerio.load(data);
  let gogoId = null;
  $('ul.items li').each((_, el) => {
    if (!gogoId) {
      const href = $(el).find('.name a').attr('href') || '';
      gogoId = href.replace('/category/', '').replace('/', '');
    }
  });
  return gogoId;
}

// ── GET /anime/search ──
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
        id:       href.replace('/category/', '').replace('/', ''),
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

// ── GET /anime/info/:id ──
app.get('/anime/info/:id', async (req, res) => {
  try {
    res.json(await fetchAnimeInfo(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/episodes/mal/:malId ──
// Gets true latest episode count from Gogoanime — no Jikan for episode data
app.get('/anime/episodes/mal/:malId', async (req, res) => {
  try {
    const malId = req.params.malId;
    let title = req.query.title || '';

    if (!title) {
      // Jikan only for title lookup — NOT episode data
      const jikan = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`, { timeout: 8000 });
      title = jikan.data.data?.title_english || jikan.data.data?.title || '';
    }

    if (!title) return res.status(500).json({ error: 'Could not resolve anime title' });

    const gogoId = await searchGogoId(title);
    if (!gogoId) return res.status(404).json({ error: 'Anime not found on Gogoanime' });

    const info = await fetchAnimeInfo(gogoId);
    res.json({ ...info, gogoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/mal/:malId/:ep ──
app.get('/anime/stream/mal/:malId/:ep', async (req, res) => {
  try {
    const { malId, ep } = req.params;
    const category = req.query.category || 'sub';

    const playerUrl = `https://gogoanime.me.uk/newplayer.php?mal_id=${malId}&ep=${ep}&category=${category}`;
    const playerRes = await axios.get(playerUrl, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      timeout: 8000,
      maxRedirects: 5,
    });

    const $p = cheerio.load(playerRes.data);
    const iframeSrc = $p('iframe').attr('src');
    const scripts   = $p('script').map((_, el) => $p(el).html()).get().join('\n');
    const m3u8Matches = scripts.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g) || [];

    res.json({ malId, ep, category, playerUrl, iframeSrc, m3u8: [...new Set(m3u8Matches)] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/:episodeId ──
app.get('/anime/stream/:episodeId', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const { data, base } = await fetchGogo(`/${episodeId}`);
    const $ = cheerio.load(data);

    const iframeSrc = $('div.play-video iframe').attr('src');
    if (!iframeSrc) return res.status(404).json({ error: 'No stream found' });

    const embedRes = await axios.get(iframeSrc, {
      headers: { ...headers, Referer: base + '/' },
      timeout: 8000,
    });
    const $e = cheerio.load(embedRes.data);
    const scripts = $e('script').map((_, el) => $e(el).html()).get().join('\n');
    const m3u8Matches = scripts.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g) || [];

    res.json({ episodeId, iframeSrc, m3u8: [...new Set(m3u8Matches)], embedUrl: iframeSrc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy/m3u8 ──
app.get('/proxy/m3u8', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    if (!url.includes('.m3u8')) return res.status(400).json({ error: 'Not an m3u8 URL' });

    const response = await axios.get(url, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      responseType: 'text',
      timeout: 8000,
    });

    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    let m3u8Content = response.data;

    m3u8Content = m3u8Content.replace(/^(?!#)([^\n\r]+)$/gm, (match) => {
      const trimmed = match.trim();
      if (!trimmed) return match;
      const absUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
      if (absUrl.includes('.m3u8')) return `/proxy/m3u8?url=${encodeURIComponent(absUrl)}`;
      return `/proxy/ts?url=${encodeURIComponent(absUrl)}`;
    });

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');
    res.send(m3u8Content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy/ts ──
app.get('/proxy/ts', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    const response = await axios.get(url, {
      headers: { ...headers, Referer: 'https://gogoanime.me.uk/' },
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    res.set('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'RyukWatches API running', version: '1.3.0' }));

app.listen(PORT, () => console.log(`RyukWatches API on port ${PORT}`));
