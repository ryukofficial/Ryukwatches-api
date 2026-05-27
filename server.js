const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Gogoanime base (rotates if one is down) ──
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

// Try each base until one works
async function fetchGogo(path) {
  for (const base of GOGO_BASES) {
    try {
      const res = await axios.get(base + path, { headers, timeout: 8000 });
      if (res.status === 200) return { data: res.data, base };
    } catch {}
  }
  throw new Error('All Gogoanime mirrors failed');
}

// ── Shared: fetch info by gogoId (no localhost self-call) ──
async function fetchAnimeInfo(gogoId) {
  const { data } = await fetchGogo(`/category/${gogoId}`);
  const $ = cheerio.load(data);
  const title = $('div.anime_info_body_bg h1').text().trim();
  const image = $('div.anime_info_body_bg img').attr('src');
  const synopsis = $('div.description').text().trim();
  const epStart = parseInt($('#episode_page a').first().attr('ep_start')) || 0;
  const epEnd = parseInt($('#episode_page a').last().attr('ep_end')) || 0;
  const animeId = $('#movie_id').val();
  const alias = $('#alias_anime').val();

  let episodes = [];
  if (animeId) {
    try {
      const epRes = await axios.get(
        `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${animeId}&default_ep=0&alias=${alias}`,
        { headers, timeout: 8000 }
      );
      const $ep = cheerio.load(epRes.data);
      $ep('li').each((_, el) => {
        const href = $ep(el).find('a').attr('href')?.trim();
        const num = $ep(el).find('.name').text().replace('EP', '').trim();
        if (href) episodes.push({ id: href.replace('/', ''), number: parseInt(num) || 0 });
      });
      episodes = episodes.reverse();
    } catch {}
  }

  // Use actual highest episode number from the list as the true total
  // (epEnd from the page header can sometimes lag for ongoing series)
  const actualTotal = episodes.length > 0
    ? Math.max(...episodes.map(e => e.number || 0), epEnd)
    : epEnd;

  return { id: gogoId, title, image, synopsis, totalEpisodes: actualTotal, episodes };
}

// ── GET /anime/search?q=naruto ──
app.get('/anime/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const page = req.query.page || 1;
    const { data } = await fetchGogo(`/search.html?keyword=${encodeURIComponent(q)}&page=${page}`);
    const $ = cheerio.load(data);
    const results = [];
    $('ul.items li').each((_, el) => {
      const a = $(el).find('.name a');
      const img = $(el).find('img').attr('src');
      const href = a.attr('href') || '';
      const id = href.replace('/category/', '').replace('/', '');
      results.push({
        id,
        title: a.text().trim(),
        image: img,
        released: $(el).find('.released').text().replace('Released:', '').trim(),
      });
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/info/:id (e.g. one-piece) ──
app.get('/anime/info/:id', async (req, res) => {
  try {
    const info = await fetchAnimeInfo(req.params.id);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/episodes/mal/:malId ── Maps MAL ID → gogoanime slug
app.get('/anime/episodes/mal/:malId', async (req, res) => {
  try {
    const malId = req.params.malId;
    // Get title from Jikan
    const jikan = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`, { timeout: 8000 });
    const title = jikan.data.data?.title_english || jikan.data.data?.title || '';

    // Search gogoanime for this title
    const { data: searchData } = await fetchGogo(`/search.html?keyword=${encodeURIComponent(title)}`);
    const $s = cheerio.load(searchData);
    let gogoId = null;
    $s('ul.items li').each((_, el) => {
      const href = $s(el).find('.name a').attr('href') || '';
      if (!gogoId) gogoId = href.replace('/category/', '').replace('/', '');
    });

    if (!gogoId) return res.status(404).json({ error: 'Anime not found on Gogoanime' });

    // FIX: call shared function instead of localhost self-call
    const info = await fetchAnimeInfo(gogoId);
    res.json({ ...info, gogoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/:episodeId ── MAIN ENDPOINT
// e.g. /anime/stream/one-piece-episode-1163
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
    const uniqueM3u8 = [...new Set(m3u8Matches)];

    const sourcesMatch = scripts.match(/sources\s*:\s*\[([^\]]+)\]/);
    let sources = [];
    if (sourcesMatch) {
      try {
        const cleaned = sourcesMatch[0]
          .replace('sources:', '')
          .replace(/'/g, '"')
          .replace(/(\w+):/g, '"$1":');
        sources = JSON.parse(cleaned.match(/\[.*\]/s)[0]);
      } catch {}
    }

    let downloadSources = [];
    try {
      const dlRes = await axios.get(iframeSrc.replace('/streaming.php', '/download'), {
        headers: { ...headers, Referer: iframeSrc },
        timeout: 5000,
      });
      const $dl = cheerio.load(dlRes.data);
      $dl('div.mirror_link a').each((_, el) => {
        downloadSources.push({
          label: $dl(el).text().trim(),
          url: $dl(el).attr('href'),
        });
      });
    } catch {}

    res.json({ episodeId, iframeSrc, m3u8: uniqueM3u8, sources, downloadSources, embedUrl: iframeSrc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /anime/stream/mal/:malId/:ep ── Stream by MAL ID + episode number
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
    const scripts = $p('script').map((_, el) => $p(el).html()).get().join('\n');
    const m3u8Matches = scripts.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g) || [];

    res.json({
      malId, ep, category,
      playerUrl,
      iframeSrc,
      m3u8: [...new Set(m3u8Matches)],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy/m3u8?url=... ── Proxy m3u8 + rewrite ALL segment URLs through /proxy/ts
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

    // FIX: rewrite ALL non-comment lines (both relative and absolute) through proxy
    m3u8Content = m3u8Content.replace(/^(?!#)([^\n\r]+)$/gm, (match) => {
      const trimmed = match.trim();
      if (!trimmed) return match;
      // Make absolute URL
      const absUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
      // If it's a sub-manifest (.m3u8), proxy through /proxy/m3u8; otherwise /proxy/ts
      if (absUrl.includes('.m3u8')) {
        return `/proxy/m3u8?url=${encodeURIComponent(absUrl)}`;
      }
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

// ── GET /proxy/ts?url=... ── Proxy video segments
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

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'RyukWatches API running', version: '1.1.0' });
});

app.listen(PORT, () => console.log(`RyukWatches API running on port ${PORT}`));
