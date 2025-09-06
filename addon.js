// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

// Real-Time Content Matching System Components
class ContentMatcher {
    constructor(omdbApiKey, logger) {
        this.omdbApiKey = omdbApiKey;
        this.log = logger;
        this.omdbCache = new Map(); // Cache OMDb results
        this.matchingThreshold = 0.8; // Similarity threshold for fuzzy matching
    }

    // Normalize title for better matching
    normalizeTitle(title) {
        if (!title) return '';
        return title
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')                    // Remove special chars
            .replace(/\s+/g, ' ')                        // Collapse whitespace
            .replace(/\b(19|20)\d{2}\b/g, '')            // Remove years
            .replace(/\b(hdtv|1080p|720p|hd|4k|uhd|bluray|webrip|dvdrip)\b/gi, '') // Remove quality tags
            .replace(/\b(dubbed|hindi|english|arabic|french|spanish)\b/gi, '')      // Remove language tags
            .replace(/\b(complete|season|series|episode|ep)\b/gi, '')               // Remove series keywords
            .trim();
    }

    // Fuzzy matching algorithm
    fuzzyMatch(title1, title2, threshold = null) {
        const useThreshold = threshold !== null ? threshold : this.matchingThreshold;
        const norm1 = this.normalizeTitle(title1);
        const norm2 = this.normalizeTitle(title2);
        
        if (norm1 === norm2) return 1.0; // Perfect match
        
        const words1 = norm1.split(/\s+/).filter(w => w.length > 2);
        const words2 = norm2.split(/\s+/).filter(w => w.length > 2);
        
        if (words1.length === 0 || words2.length === 0) return 0;
        
        const matches = words1.filter(word => words2.includes(word)).length;
        const similarity = matches / Math.max(words1.length, words2.length);
        
        return similarity;
    }

    // Get official title from OMDb API
    async getOfficialTitle(imdbId) {
        if (this.omdbCache.has(imdbId)) {
            return this.omdbCache.get(imdbId);
        }

        if (!this.omdbApiKey) {
            this.log.warn('OMDb API key not configured');
            return null;
        }

        try {
            const response = await fetch(`http://www.omdbapi.com/?apikey=${this.omdbApiKey}&i=${imdbId}&plot=short`);
            const data = await response.json();
            
            if (data.Response === 'True') {
                const result = {
                    title: data.Title,
                    year: data.Year,
                    type: data.Type,
                    plot: data.Plot
                };
                this.omdbCache.set(imdbId, result);
                this.log.debug(`🎬 OMDb found: ${data.Title} (${data.Year})`);
                return result;
            } else {
                this.log.warn(`❌ OMDb API error for ${imdbId}: ${data.Error}`);
                this.omdbCache.set(imdbId, null);
                return null;
            }
        } catch (error) {
            this.log.error(`❌ OMDb API request failed for ${imdbId}:`, error.message);
            return null;
        }
    }

    // Find best match in content library
    findBestMatch(targetTitle, contentLibrary, contentType = 'movie') {
        let bestMatch = null;
        let bestScore = 0;
        
        for (const item of contentLibrary) {
            const itemTitle = item.name || item.title || '';
            const score = this.fuzzyMatch(targetTitle, itemTitle);
            
            if (score > bestScore && score >= this.matchingThreshold) {
                bestScore = score;
                bestMatch = item;
            }
        }
        
        if (bestMatch) {
            this.log.debug(`🎯 Best match found: "${bestMatch.name || bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
        }
        
        return { match: bestMatch, score: bestScore };
    }
}

let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        includeSeries: config.includeSeries !== false // default true
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        this.seriesInfoCache = new Map(); // seriesId -> { videos: [...], fetchedAt }
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();

        // Real-Time Content Matching System
        this.contentMatcher = new ContentMatcher(process.env.OMDB_API_KEY, this.log);
        this.realTimeCache = new Map(); // Cache for IMDB-based requests

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours,
            includeSeries: this.config.includeSeries
        });
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            // Direct series episodes index is not persisted; rebuild on next fetch
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                lastUpdate: new Date(this.lastUpdate).toISOString()
            });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
        this.log.debug('Saved data to cache');
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const tvCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_channels');
        const movieCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_movies');
        const seriesCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_series');

        if (tvCatalog) {
            const groups = [
                ...new Set(
                    this.channels
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            tvCatalog.genres = groups;
        }

        if (movieCatalog) {
            const movieGroups = [
                ...new Set(
                    this.movies
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            movieCatalog.genres = movieGroups;
        }

        if (seriesCatalog) {
            const seriesGroups = [
                ...new Set(
                    this.series
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            seriesCatalog.genres = seriesGroups;
        }

        this.log.debug('Catalog genres built', {
            tvGenres: tvCatalog?.genres?.length || 0,
            movieGenres: movieCatalog?.genres?.length || 0,
            seriesGenres: seriesCatalog?.genres?.length || 0
        });
    }

    parseM3U(content) {
        const startTs = Date.now();
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];

                const group = (currentItem.attributes['group-title'] || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();

                const isMovie =
                    group.includes('movie') ||
                    lower.includes('movie') ||
                    this.isMovieFormat(currentItem.name);

                const isSeries =
                    !isMovie && (
                        group.includes('series') ||
                        group.includes('show') ||
                        /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) ||
                        /\bSeason\s?\d+/i.test(currentItem.name)
                    );

                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        const ms = Date.now() - startTs;
        this.log.debug('M3U parsed', { lines: lines.length, items: items.length, ms });
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        const start = Date.now();
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            this.log.debug('EPG parsed', {
                channels: Object.keys(epgData).length,
                programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
                ms: Date.now() - start
            });
            return epgData;
        } catch (e) {
            this.log.warn('EPG parse failed', e.message);
            return {};
        }
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            let date;
            if (tz) {
                const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) date = parsed;
            }
            if (!date) date = new Date(year, month, day, hour, min, sec);
            if (this.config.epgOffsetHours) {
                date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            }
            return date;
        }
        const d = new Date(s);
        if (this.config.epgOffsetHours && !isNaN(d.getTime()))
            return new Date(d.getTime() + this.config.epgOffsetHours * 3600000);
        return d;
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) {
                return { title: p.title, description: p.desc, start, stop, startTime: start, stopTime: stop };
            }
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        if (!channelId || !this.epgData[channelId]) return [];
        const now = new Date();
        const upcoming = [];
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            if (start > now && upcoming.length < limit) {
                upcoming.push({
                    title: p.title,
                    description: p.desc,
                    startTime: start,
                    stopTime: this.parseEPGTime(p.stop)
                });
            }
        }
        return upcoming.sort((a, b) => a.startTime - b.startTime);
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);

        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            if (typeof providerModule.fetchSeriesInfo === 'function') {
                const info = await providerModule.fetchSeriesInfo(this, seriesId);
                this.seriesInfoCache.set(seriesId, info);
                return info;
            }
        } catch (e) {
            this.log.warn('Series info fetch failed', seriesId, e.message);
        }
        // Fallback empty structure
        const empty = { videos: [] };
        this.seriesInfoCache.set(seriesId, empty);
        return empty;
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if ((this.channels.length || this.movies.length || this.series.length) && now - this.lastUpdate < 900000) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                ms: Date.now() - start
            });
        } catch (e) {
            this.log.error('[UPDATE] Failed:', e.message);
        }
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            meta.description = current
                ? `📡 Now: ${current.title}${current.description ? `\n${current.description}` : ''}`
                : '📡 Live Channel';
            meta.poster = this.deriveFallbackLogoUrl(item);
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
            meta.runtime = 'Live';
        } else if (item.type === 'movie') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.year = item.year;
            if (!meta.year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) meta.year = parseInt(m[1]);
            }
            meta.description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            meta.genres = item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'];
        } else if (item.type === 'series') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.description = item.plot || item.attributes?.['plot'] || 'Series / Show';
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Series']);
        }
        return meta;
    }

    getStream(id) {
        // Handle new Stremio-format series episode IDs: {seriesId}:{season}:{episode}
        if (id.includes(':') && id.match(/^iptv_series_\d+:\d+:\d+$/)) {
            const [seriesId, seasonStr, episodeStr] = id.split(':');
            const season = Number(seasonStr);
            const episode = Number(episodeStr);
            
            // Find the episode in cached series info
            for (const [, info] of this.seriesInfoCache.entries()) {
                if (info && Array.isArray(info.videos)) {
                    const epEntry = info.videos.find(v => 
                        Number(v.season) === season && 
                        Number(v.episode) === episode
                    );
                    if (epEntry && epEntry.url) {
                        return {
                            url: epEntry.url,
                            title: `${epEntry.title || `Episode ${episode}`} S${season}E${episode}`,
                            behaviorHints: { notWebReady: true }
                        };
                    }
                }
            }
            
            // Fallback: lookup by original ID format
            const epEntry = this.lookupEpisodeById(`iptv_series_ep_${seasonStr}_${episodeStr}`);
            if (epEntry) {
                return {
                    url: epEntry.url,
                    title: `${epEntry.title || 'Episode'} S${season}E${episode}`,
                    behaviorHints: { notWebReady: true }
                };
            }
            return null;
        }
        
        // Legacy episode streams
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            if (!epEntry) return null;
            return {
                url: epEntry.url,
                title: `${epEntry.title || 'Episode'}${epEntry.season ? ` S${epEntry.season}E${epEntry.episode}` : ''}`,
                behaviorHints: { notWebReady: true }
            };
        }
        
        // Regular channels and movies
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return {
            url: item.url,
            title: item.type === 'tv' ? `${item.name} - Live` : item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    lookupEpisodeById(epId) {
        // Check cached series info
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        // Direct provider inline index
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const videos = (info?.videos || []).filter(v => v && v.id && v.title && v.url).map(v => {
            const season = Number(v.season) || 1;
            const episode = Number(v.episode) || 0;
            // Stremio expects video ID format: {seriesId}:{season}:{episode}
            const videoId = `${seriesItem.id}:${season}:${episode}`;
            
            // Format released date to ISO 8601 if available
            let releasedDate = null;
            if (v.released) {
                try {
                    releasedDate = new Date(v.released).toISOString();
                } catch (e) {
                    releasedDate = new Date().toISOString(); // fallback to current date
                }
            } else {
                releasedDate = new Date().toISOString(); // default to current date
            }
            
            return {
                id: videoId,
                title: v.title || `Episode ${episode}`,
                season: season,
                episode: episode,
                released: releasedDate,
                thumbnail: v.thumbnail || seriesItem.poster || seriesItem.attributes?.['tvg-logo'],
                // Store original data for stream resolution
                _originalId: v.id,
                _url: v.url,
                _streamId: v.stream_id || v.id
            };
        });

        const meta = {
            id: seriesItem.id,
            type: 'series',
            name: seriesItem.name,
            poster: seriesItem.poster ||
                seriesItem.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(seriesItem.name)}`,
            description: seriesItem.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
            genres: seriesItem.category
                ? [seriesItem.category]
                : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
            videos
        };

        if (this.config.debug) {
            this.log.debug('Built series meta', {
                seriesId: seriesItem.id,
                name: seriesItem.name,
                videoCount: videos.length,
                firstVideo: videos[0] ? {
                    id: videos[0].id,
                    title: videos[0].title,
                    season: videos[0].season,
                    episode: videos[0].episode,
                    hasUrl: !!videos[0].url,
                    hasStreamId: !!videos[0].stream_id
                } : null,
                sampleVideos: videos.slice(0, 3).map(v => ({
                    id: v.id,
                    title: v.title,
                    season: v.season,
                    episode: v.episode,
                    hasUrl: !!v.url,
                    urlPreview: v.url ? v.url.substring(0, 50) + '...' : null
                }))
            });
        }

        return meta;
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        // fallback sync path
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            const upcoming = this.getUpcomingPrograms(epgId, 3);
            let description = `📺 CHANNEL: ${item.name}`;
            if (current) {
                const start = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                const end = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
                if (current.description) description += `\n\n${current.description}`;
            }
            if (upcoming.length) {
                description += '\n\n📅 UPCOMING:\n';
                for (const p of upcoming) {
                    description += `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}\n`;
                }
            }
            return {
                id: item.id,
                type: 'tv',
                name: item.name,
                poster: this.deriveFallbackLogoUrl(item),
                description,
                genres: item.category
                    ? [item.category]
                    : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
                runtime: 'Live'
            };
        } else {
            let year = item.year;
            if (!year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) year = parseInt(m[1]);
            }
            const description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            return {
                id: item.id,
                type: 'movie',
                name: item.name,
                poster: item.poster || item.attributes?.['tvg-logo'] ||
                    `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`,
                description,
                genres: item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'],
                year
            };
        }
    }

    // Real-Time Content Matching System Methods
    
    // Parse IMDB ID and extract episode info if applicable
    parseImdbRequest(id) {
        if (id.includes(':')) {
            // Format: tt1234567:1:1 (imdbId:season:episode)
            const parts = id.split(':');
            if (parts.length === 3) {
                return {
                    imdbId: parts[0],
                    season: parseInt(parts[1]),
                    episode: parseInt(parts[2]),
                    isEpisode: true
                };
            }
        }
        return {
            imdbId: id,
            isEpisode: false
        };
    }

    // Real-time movie search using IMDB ID
    async searchMovieByImdbId(imdbId) {
        this.log.debug(`🔍 Searching IPTV library for IMDB ID: ${imdbId}`);
        
        // Check cache first
        if (this.realTimeCache.has(imdbId)) {
            const cached = this.realTimeCache.get(imdbId);
            if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                this.log.debug(`📦 Using cached result for ${imdbId}`);
                return cached.result;
            }
        }

        try {
            // Get official title from OMDb
            const omdbData = await this.contentMatcher.getOfficialTitle(imdbId);
            if (!omdbData) {
                this.log.warn(`❌ Could not get movie title from OMDb for ${imdbId}`);
                return null;
            }

            // Ensure fresh IPTV data
            if (this.movies.length === 0) {
                this.log.debug(`🎬 No stored content found, searching IPTV provider for movie...`);
                await this.updateData(false);
            }

            this.log.debug(`📊 Total movies in IPTV library: ${this.movies.length}`);
            this.log.debug(`🎯 Searching IPTV library for: "${omdbData.title}"`);

            // Find best match
            const { match, score } = this.contentMatcher.findBestMatch(omdbData.title, this.movies, 'movie');
            
            if (match) {
                this.log.debug(`✅ Added stream for: ${match.name}`);
                
                // Cache the result
                this.realTimeCache.set(imdbId, {
                    result: match,
                    timestamp: Date.now()
                });
                
                return match;
            } else {
                this.log.warn(`❌ No suitable match found for "${omdbData.title}" in IPTV library`);
                return null;
            }
        } catch (error) {
            this.log.error(`❌ Error searching for movie ${imdbId}:`, error.message);
            return null;
        }
    }

    // Real-time series episode search using IMDB ID
    async searchEpisodeByImdbId(imdbId, season, episode) {
        this.log.debug(`🔍 Searching IPTV library for IMDB ID: ${imdbId}:${season}:${episode}`);
        
        // Check cache first
        const cacheKey = `${imdbId}:${season}:${episode}`;
        if (this.realTimeCache.has(cacheKey)) {
            const cached = this.realTimeCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                this.log.debug(`📦 Using cached result for ${cacheKey}`);
                return cached.result;
            }
        }

        try {
            // Get official title from OMDb
            const omdbData = await this.contentMatcher.getOfficialTitle(imdbId);
            if (!omdbData) {
                this.log.warn(`❌ Could not get series title from OMDb for ${imdbId}`);
                return null;
            }

            // Ensure fresh IPTV data
            if (this.series.length === 0) {
                this.log.debug(`📺 No stored content found, searching IPTV provider for series...`);
                await this.updateData(false);
            }

            this.log.debug(`🎯 Looking for series ${imdbId}, Season ${season}, Episode ${episode}`);
            this.log.debug(`📊 Total series in IPTV library: ${this.series.length}`);
            this.log.debug(`🎯 Searching IPTV library for series: "${omdbData.title}"`);

            // Find best series match
            const { match: seriesMatch } = this.contentMatcher.findBestMatch(omdbData.title, this.series, 'series');
            
            if (seriesMatch) {
                // Get series episodes
                const seriesInfo = await this.ensureSeriesInfo(seriesMatch.series_id || seriesMatch.id.replace(/^iptv_series_/, ''));
                
                if (seriesInfo && Array.isArray(seriesInfo.videos)) {
                    this.log.debug(`📺 Series has episodes data, looking for S${season}E${episode}`);
                    
                    // Find specific episode
                    const episodeMatch = seriesInfo.videos.find(v => 
                        Number(v.season) === season && Number(v.episode) === episode
                    );
                    
                    if (episodeMatch) {
                        this.log.debug(`✅ Added stream for: ${seriesMatch.name} S${season}E${episode}`);
                        
                        // Cache the result
                        this.realTimeCache.set(cacheKey, {
                            result: {
                                ...episodeMatch,
                                seriesName: seriesMatch.name,
                                seriesId: seriesMatch.id
                            },
                            timestamp: Date.now()
                        });
                        
                        return {
                            ...episodeMatch,
                            seriesName: seriesMatch.name,
                            seriesId: seriesMatch.id
                        };
                    } else {
                        this.log.warn(`❌ Episode S${season}E${episode} not found in series "${seriesMatch.name}"`);
                    }
                } else {
                    this.log.warn(`❌ No episodes data available for series "${seriesMatch.name}"`);
                }
            } else {
                this.log.warn(`❌ No suitable series match found for "${omdbData.title}" in IPTV library`);
            }
            
            return null;
        } catch (error) {
            this.log.error(`❌ Error searching for episode ${imdbId}:${season}:${episode}:`, error.message);
            return null;
        }
    }
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.0.0",
        name: ADDON_NAME,
        description: "IPTV addon (M3U / EPG / Xtream) with encrypted configs, caching & series support (Xtream + Direct)",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: 'IPTV Channels',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'IPTV Movies',
                extra: [{ name: 'search' }, { name: 'skip' }],
                genres: []
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: 'IPTV Series',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            }
        ],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    config.instanceId = config.instanceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));

    const cacheKey = createCacheKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { cacheKey, provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing build promise', cacheKey);
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        await addonInstance.updateData(true);
        addonInstance.buildGenresInManifest();

        builder.defineCatalogHandler(async (args) => {
            const start = Date.now();
            try {
                addonInstance.updateData().catch(() => { });
                let items = [];
                if (args.type === 'tv' && args.id === 'iptv_channels') {
                    items = addonInstance.channels;
                } else if (args.type === 'movie' && args.id === 'iptv_movies') {
                    items = addonInstance.movies;
                } else if (args.type === 'series' && args.id === 'iptv_series') {
                    if (addonInstance.config.includeSeries !== false)
                        items = addonInstance.series;
                }
                const extra = args.extra || {};
                if (extra.genre && extra.genre !== 'All Channels') {
                    items = items.filter(i =>
                        (i.category && i.category === extra.genre) ||
                        (i.attributes && i.attributes['group-title'] === extra.genre)
                    );
                }
                if (extra.search) {
                    const q = extra.search.toLowerCase();
                    items = items.filter(i => i.name.toLowerCase().includes(q));
                }
                const metas = items.slice(0, 200).map(i => addonInstance.generateMetaPreview(i));
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        totalItems: items.length,
                        returned: metas.length,
                        ms: Date.now() - start
                    });
                }
                return { metas };
            } catch (e) {
                console.error('[CATALOG] Error', e);
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                // DEBUG: Log all incoming stream requests
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Stream request received:', { type, id, isImdbId: id.match(/^tt\d+/) ? true : false });
                }
                
                // Real-Time Content Matching System: Handle IMDB ID-based requests
                if (id.match(/^tt\d+/)) {
                    const parseResult = addonInstance.parseImdbRequest(id);
                    
                    if (parseResult.isEpisode) {
                        // Handle series episode: tt1234567:1:1
                        const episodeData = await addonInstance.searchEpisodeByImdbId(
                            parseResult.imdbId, 
                            parseResult.season, 
                            parseResult.episode
                        );
                        
                        if (episodeData && episodeData.url) {
                            const stream = {
                                url: episodeData.url,
                                title: `${episodeData.seriesName || 'Series'} S${parseResult.season}E${parseResult.episode}${episodeData.title ? ` - ${episodeData.title}` : ''}`,
                                behaviorHints: { notWebReady: true }
                            };
                            
                            if (addonInstance.config.debug) {
                                console.log('[DEBUG] Real-time episode stream found', { 
                                    id, 
                                    title: stream.title,
                                    url: stream.url.substring(0, 60) + '...'
                                });
                            }
                            
                            return { streams: [stream] };
                        }
                    } else {
                        // Handle movie: tt1234567
                        const movieData = await addonInstance.searchMovieByImdbId(parseResult.imdbId);
                        
                        if (movieData && movieData.url) {
                            const stream = {
                                url: movieData.url,
                                title: movieData.name || movieData.title || 'Movie',
                                behaviorHints: { notWebReady: true }
                            };
                            
                            if (addonInstance.config.debug) {
                                console.log('[DEBUG] Real-time movie stream found', { 
                                    id, 
                                    title: stream.title,
                                    url: stream.url.substring(0, 60) + '...'
                                });
                            }
                            
                            return { streams: [stream] };
                        }
                    }
                    
                    // No real-time match found
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] No real-time match found for IMDB ID:', id);
                    }
                    return { streams: [] };
                }

                // Handle existing series formats (series_id:season:episode) and legacy format
                if (id.includes(':') && id.match(/^iptv_series_\d+:\d+:\d+$/) || id.startsWith('iptv_series_ep_')) {
                    const stream = addonInstance.getStream(id);
                    if (!stream) return { streams: [] };
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series Episode Stream request', { 
                            id, 
                            url: stream.url ? stream.url.substring(0, 60) + '...' : 'no url',
                            title: stream.title 
                        });
                    }
                    return { streams: [stream] };
                }
                
                // Handle regular content (channels, movies from catalogs)
                const stream = addonInstance.getStream(id);
                if (!stream) return { streams: [] };
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Stream request', { 
                        id, 
                        type,
                        url: stream.url ? stream.url.substring(0, 60) + '...' : 'no url' 
                    });
                }
                return { streams: [stream] };
            } catch (e) {
                console.error('[STREAM] Error for id:', id, e);
                return { streams: [] };
            }
        });

        builder.defineMetaHandler(async ({ type, id }) => {
            try {
                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = await addonInstance.getDetailedMetaAsync(id, 'series');
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series meta request', { 
                            id, 
                            type,
                            metaFound: !!meta,
                            videos: meta?.videos?.length,
                            metaKeys: meta ? Object.keys(meta) : null
                        });
                    }
                    if (!meta) {
                        console.warn('[META] No series meta found for id:', id);
                        return { meta: null };
                    }
                    return { meta };
                }
                const meta = addonInstance.getDetailedMeta(id);
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta request', { id, type, metaFound: !!meta });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error for id:', id, 'type:', type, e);
                return { meta: null };
            }
        });

        return builder.getInterface();
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } finally {
        // Keep promise cached
    }
}

module.exports = createAddon;