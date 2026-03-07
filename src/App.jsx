import React, { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── AniList GraphQL ──────────────────────────────────────────────────────────
const ANILIST_URL = "/api/anilist";

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  status
  season
  seasonYear
  episodes
  averageScore
  popularity
  coverImage { large medium color }
  bannerImage
  genres
  format
  countryOfOrigin
  startDate { year month day }
  nextAiringEpisode { episode airingAt }
  studios(isMain: true) { nodes { name } }
  externalLinks { site url type language }
  streamingEpisodes { title thumbnail url site }
  synonyms
  description(asHtml: false)
`;

const AIRING_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage lastPage }
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) {
      ${MEDIA_FIELDS}
    }
  }
}`;

const UPCOMING_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC) {
      ${MEDIA_FIELDS}
    }
  }
}`;

const POPULAR_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC, format_in: [TV, MOVIE, OVA, ONA]) {
      ${MEDIA_FIELDS}
    }
  }
}`;

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, search: $search, sort: POPULARITY_DESC) {
      ${MEDIA_FIELDS}
    }
  }
}`;

async function anilistFetch(query, variables = {}) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "60", 10);
    console.warn(`AniList rate limited — waiting ${retryAfter}s`);
    await new Promise(r => setTimeout(r, (retryAfter + 2) * 1000));
    // Retry once after waiting
    const retry = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!retry.ok) throw new Error(`AniList HTTP ${retry.status} after retry`);
    const json = await retry.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ─── Dub Detection ────────────────────────────────────────────────────────────
// AniList doesn't have a direct "isDubbed" field, so we infer it:
// 1. Check externalLinks for English-language streaming sites
// 2. Check streamingEpisodes (presence often = English stream available)
// 3. Check if countryOfOrigin is NOT JP but has English title (CN/KR anime often get dubs)
// 4. Known dub platforms in externalLinks
const DUB_PLATFORMS = ["crunchyroll", "funimation", "netflix", "hidive", "hulu", "amazon", "tubi", "disney"];

function detectDubStatus(media) {
  const links = media.externalLinks || [];
  const streaming = media.streamingEpisodes || [];

  // Has English-language streaming link
  const hasEnglishLink = links.some(l =>
    l.language === "English" ||
    (l.type === "STREAMING" && DUB_PLATFORMS.some(p => (l.site || "").toLowerCase().includes(p)))
  );

  // Has streaming episodes listed (strong signal)
  const hasStreamingEps = streaming.length > 0;

  // Funimation/HIDIVE link = almost always has dub
  const hasDubPlatform = links.some(l =>
    ["funimation", "hidive"].some(p => (l.site || "").toLowerCase().includes(p))
  );

  // Non-Japanese origin with English title = likely dubbed
  const nonJpWithEnglish = media.countryOfOrigin !== "JP" && !!media.title?.english;

  if (hasDubPlatform) return "dubbed";
  if (hasEnglishLink && hasStreamingEps) return "dubbed";
  if (hasEnglishLink) return "likely_dubbed";
  if (nonJpWithEnglish) return "likely_dubbed";
  if (hasStreamingEps) return "sub_only";
  return "unknown";
}

// ─── Supabase ────────────────────────────────────────────────────────────────
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);
const WEEK_MS       = 7 * 24 * 60 * 60 * 1000;

// ─── Supabase DB helpers ──────────────────────────────────────────────────────
const sbAnime = {
  getAll: async ({ status } = {}) => {
    let q = supabase.from("anime").select("*");
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    // Normalise snake_case → camelCase shape the rest of the app expects
    return (data || []).map(normaliseRow);
  },

  search: async (term) => {
    const q = term.toLowerCase();
    // Supabase full-text or ilike on title jsonb — use ilike on cast
    const { data, error } = await supabase
      .from("anime")
      .select("*")
      .or(`title->>english.ilike.%${q}%,title->>romaji.ilike.%${q}%`)
      .order("score", { ascending: false })
      .limit(48);
    if (error) throw error;
    return (data || []).map(normaliseRow);
  },

  count: async () => {
    const { count } = await supabase.from("anime").select("*", { count: "exact", head: true });
    return count || 0;
  },

  upsertBatch: async (items) => {
    const BATCH = 500;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH).map(toRow);
      console.log(`Upserting batch ${i}–${i + slice.length}, first item id:`, slice[0]?.id);
      const { error } = await supabase.from("anime").upsert(slice, { onConflict: "id" });
      if (error) {
        console.error("Supabase upsert error:", error);
        throw new Error(`Supabase upsert failed: ${error.message} (code: ${error.code})`);
      }
      console.log(`Batch ${i} OK`);
    }
  },
};

const sbMeta = {
  get: async (key) => {
    const { data } = await supabase.from("timetable_cache").select("data").eq("id", key).maybeSingle();
    return data?.data ?? null;
  },
  set: async (key, value) => {
    await supabase.from("timetable_cache").upsert({ id: key, data: value, fetched_at: new Date().toISOString() });
  },
};

// Map Supabase snake_case row → camelCase shape the components expect
function normaliseRow(r) {
  return {
    id:                  r.id,
    title:               r.title,
    status:              r.status,
    season:              r.season,
    seasonYear:          r.season_year,
    episodes:            r.episodes,
    averageScore:        r.score,
    score:               r.score,
    popularity:          r.popularity,
    coverImage:          r.cover_image,
    bannerImage:         r.banner_image,
    genres:              r.genres,
    format:              r.format,
    countryOfOrigin:     r.country_of_origin,
    startDate:           r.start_date,
    nextAiringEpisode:   r.next_airing_episode,
    studios:             r.studios,
    externalLinks:       r.external_links,
    streamingEpisodes:   r.streaming_episodes,
    synonyms:            r.synonyms,
    description:         r.description,
    dubStatus:           r.dub_status,
  };
}

// Map enriched AniList item → Supabase row (snake_case)
function toRow(m) {
  return {
    id:                  m.id,
    title:               m.title,
    status:              m.status,
    season:              m.season,
    season_year:         m.seasonYear,
    episodes:            m.episodes,
    score:               m.averageScore || 0,
    popularity:          m.popularity,
    cover_image:         m.coverImage,
    banner_image:        m.bannerImage,
    genres:              m.genres,
    format:              m.format,
    country_of_origin:   m.countryOfOrigin,
    start_date:          m.startDate,
    next_airing_episode: m.nextAiringEpisode,
    studios:             m.studios,
    external_links:      m.externalLinks,
    streaming_episodes:  m.streamingEpisodes,
    synonyms:            m.synonyms,
    description:         m.description,
    dub_status:          m.dubStatus,
    updated_at:          new Date().toISOString(),
  };
}

// ─── Sync Engine ─────────────────────────────────────────────────────────────
async function fetchPages(query, maxPages, onProgress, label) {
  const all = new Map();
  for (let page = 1; page <= maxPages; page++) {
    let retries = 3;
    while (retries > 0) {
      try {
        await new Promise(r => setTimeout(r, 2000)); // ~30 req/min, well under AniList's 90/min limit
        const data = await anilistFetch(query, { page, perPage: 50 });
        const pageData = data?.Page;
        const items = pageData?.media || [];
        items.forEach(m => {
          const enriched = { ...m, dubStatus: detectDubStatus(m), score: m.averageScore || 0 };
          all.set(m.id, enriched);
        });
        if (onProgress) onProgress({ label: `${label} — page ${page}`, fetched: all.size });
        if (!pageData?.pageInfo?.hasNextPage) return [...all.values()];
        break; // success, move to next page
      } catch (e) {
        retries--;
        if (retries === 0) {
          if (page === 1) throw e;
          return [...all.values()]; // return what we have
        }
        await new Promise(r => setTimeout(r, 3000 * (4 - retries))); // back-off
      }
    }
  }
  return [...all.values()];
}

async function runFullSync(onProgress) {
  const tasks = [
    { label: "Currently airing",  query: AIRING_QUERY,   pages: 8  },
    { label: "Popular all-time",  query: POPULAR_QUERY,  pages: 20 },
    { label: "Upcoming anime",    query: UPCOMING_QUERY, pages: 5  },
  ];

  const allItems = new Map();

  for (let t = 0; t < tasks.length; t++) {
    const task = tasks[t];
    onProgress({ phase: task.label, taskIndex: t, taskTotal: tasks.length, fetched: allItems.size });
    try {
      const items = await fetchPages(task.query, task.pages, (prog) => {
        onProgress({ phase: prog.label, taskIndex: t, taskTotal: tasks.length, fetched: allItems.size + prog.fetched });
      }, task.label);
      items.forEach(a => allItems.set(a.id, a));
    } catch (e) { /* skip failed task */ }
  }

  await sbAnime.upsertBatch([...allItems.values()]);
  // Store last sync timestamp in timetable_cache table (reuse as kv store)
  await sbMeta.set("last_sync", { ts: Date.now(), count: allItems.size });
  return allItems.size;
}

// Check if a sync is needed based on last_sync stored in Supabase
async function checkNeedsSync() {
  const meta = await sbMeta.get("last_sync");
  if (!meta?.ts) return { needsSync: true, firstRun: true, lastSync: null, totalCount: 0 };
  const needsSync = Date.now() - meta.ts > WEEK_MS;
  return { needsSync, firstRun: false, lastSync: meta.ts, totalCount: meta.count || 0 };
}

// ─── Constants ───────────────────────────────────────────────────────────────
const NAV = [
  { id: "airing",   label: "Dub Calendar",  icon: "◷" },
  { id: "upcoming", label: "Upcoming",       icon: "◈" },
  { id: "search",   label: "Search",         icon: "⌕" },
  { id: "watch",    label: "Where to Watch", icon: "◉" },
];

const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const SCHEDULE_KEY = import.meta.env.VITE_ANIMESCHEDULE_KEY || "";
const SCHEDULE_CACHE_KEY = "animeschedule_timetable";
const SCHEDULE_TTL = 7 * 24 * 60 * 60 * 1000;

const STREAM_COLORS = {
  crunchyroll: "#F47521", funimation: "#5B2D8E", netflix: "#E50914",
  hidive: "#00AEEF", hulu: "#1CE783", amazon: "#00A8E0",
  tubi: "#FA541C", disney: "#113CCF", youtube: "#FF0000",
  vrv: "#000000",
};

function getStreamColor(site = "") {
  const key = site.toLowerCase();
  for (const [name, color] of Object.entries(STREAM_COLORS)) {
    if (key.includes(name)) return color;
  }
  return "#555";
}

async function fetchDubTimetable() {
  // Check sessionStorage cache first
  try {
    const raw = sessionStorage.getItem(SCHEDULE_CACHE_KEY);
    if (raw) {
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < SCHEDULE_TTL) return data;
    }
  } catch {}

  if (!SCHEDULE_KEY) {
    throw new Error("No API key found. Add VITE_ANIMESCHEDULE_KEY to your .env file and restart the dev server.");
  }

  let res;
  try {
    res = await fetch("/api/animeschedule", {
      headers: { "Authorization": `Bearer ${SCHEDULE_KEY}` },
    });
  } catch (e) {
    throw new Error(`Network error — check your internet connection. (${e.message})`);
  }

  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    if (res.status === 401) throw new Error("401 Unauthorized — API key is invalid or expired. Regenerate it at animeschedule.net.");
    if (res.status === 403) throw new Error("403 Forbidden — API key may not have timetable access, or CORS is blocking the request.");
    if (res.status === 429) throw new Error("429 Rate limited — too many requests. Try again in a few minutes.");
    throw new Error(`API error ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json();
  // The API returns an object with day keys, or an array — handle both
  const shows = Array.isArray(data) ? data : Object.values(data).flat();

  try {
    sessionStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify({ data: shows, ts: Date.now() }));
  } catch {}

  return shows;
}

// Normalize a show from AnimeSchedule — fields are PascalCase
function normalizeShow(show) {
  return {
    title:         show.Title        || show.title        || "",
    english:       show.English      || show.english      || "",
    romaji:        show.Romaji       || show.romaji       || "",
    route:         show.Route        || show.route        || "",
    episodeDate:   show.EpisodeDate  || show.episodeDate  || "",
    episodeNumber: show.EpisodeNumber|| show.episodeNumber|| null,
    episodes:      show.Episodes     || show.episodes     || null,
    imageVersionRoute: show.ImageVersionRoute || show.imageVersionRoute || "",
    airingStatus:  show.AiringStatus || show.airingStatus || "",
    streams:       show.Streams      || show.streams      || {},
    airType:       show.AirType      || show.airType      || "",
  };
}

// Group timetable array by day of week using EpisodeDate
function groupByDay(rawShows) {
  const grouped = { sunday:[], monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[] };
  for (const raw of rawShows) {
    const show = normalizeShow(raw);
    const date = new Date(show.episodeDate);
    if (isNaN(date)) continue;
    const day = DAYS[date.getDay()]; // local day
    if (grouped[day]) grouped[day].push(show);
  }
  for (const day of DAYS) {
    grouped[day].sort((a, b) => new Date(a.episodeDate) - new Date(b.episodeDate));
  }
  return grouped;

}

// Given a show and the AniList local DB, return enriched streaming links
// Falls back to AnimeSchedule streams, then animeschedule.net show page
async function getShowLinks(show) {
  // 1. Use streams from AnimeSchedule if they exist and are non-empty URLs
  const schedStreams = show.streams || {};
  const validStreams = Object.entries(schedStreams).filter(([, url]) => typeof url === "string" && url.startsWith("http"));
  if (validStreams.length > 0) return Object.fromEntries(validStreams);

  // 2. Cross-reference Supabase anime table by title match
  try {
    const titleLower = (show.english || show.romaji || show.title || "").toLowerCase();
    const matches = await sbAnime.search(titleLower);
    const match = matches[0];
    if (match?.externalLinks) {
      const links = match.externalLinks
        .filter(l => l.type === "STREAMING" && l.url)
        .reduce((acc, l) => { acc[l.site] = l.url; return acc; }, {});
      if (Object.keys(links).length > 0) return links;
    }
  } catch {}

  // No links found — return empty so card shows no stream area
  return {};
}

const STREAMING = [
  { name: "Crunchyroll", url: "https://crunchyroll.com",               color: "#F47521", desc: "Largest anime library, simulcasts + dubs",  logo: "CR" },
  { name: "Funimation",  url: "https://funimation.com",                color: "#5B2D8E", desc: "Dub specialists, huge English dub library",  logo: "FN" },
  { name: "Netflix",     url: "https://netflix.com/browse/genre/7424", color: "#E50914", desc: "Exclusive originals + licensed dubs",        logo: "NF" },
  { name: "HIDIVE",      url: "https://hidive.com",                    color: "#00AEEF", desc: "Niche & classic, growing dub catalog",       logo: "HD" },
  { name: "Tubi",        url: "https://tubitv.com/category/anime",     color: "#FA541C", desc: "Free ad-supported anime streaming",          logo: "TB" },
  { name: "Hulu",        url: "https://hulu.com/hub/anime",            color: "#1CE783", desc: "Mix of dubbed and subbed anime",             logo: "HU" },
];

const DUB_LABELS = {
  dubbed:       { text: "DUBBED",       bg: "rgba(34,197,94,0.2)",  color: "#4ade80" },
  likely_dubbed:{ text: "LIKELY DUB",   bg: "rgba(234,179,8,0.2)",  color: "#facc15" },
  sub_only:     { text: "SUB ONLY",     bg: "rgba(99,102,241,0.2)", color: "#a5b4fc" },
  unknown:      { text: "UNKNOWN",      bg: "rgba(107,114,128,0.2)",color: "#6b7280" },
};

const STATUS_LABELS = {
  RELEASING:       { text: "AIRING",    bg: "rgba(34,197,94,0.15)",  color: "#4ade80" },
  NOT_YET_RELEASED:{ text: "UPCOMING",  bg: "rgba(99,102,241,0.15)", color: "#a5b4fc" },
  FINISHED:        { text: "FINISHED",  bg: "rgba(107,114,128,0.15)",color: "#6b7280" },
};

const btnStyle = {
  background: "#dc2626", color: "#fff", border: "none",
  borderRadius: "8px", padding: "10px 18px", fontSize: "13px",
  fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  letterSpacing: "0.05em", transition: "background 0.2s ease",
};

// ─── Streaming platform config (for card pills) ───────────────────────────────
const PLATFORM_STYLES = {
  crunchyroll: { label: "CR",  color: "#F47521" },
  funimation:  { label: "FN",  color: "#5B2D8E" },
  netflix:     { label: "NF",  color: "#E50914" },
  hidive:      { label: "HD",  color: "#00AEEF" },
  hulu:        { label: "HU",  color: "#1CE783" },
  amazon:      { label: "AZ",  color: "#00A8E0" },
  tubi:        { label: "TB",  color: "#FA541C" },
  disney:      { label: "D+",  color: "#113CCF" },
  youtube:     { label: "YT",  color: "#FF0000" },
};

function getStreamingPlatforms(anime) {
  const links = anime.externalLinks || [];
  const seen = new Set();
  const platforms = [];
  for (const link of links) {
    if (link.type !== "STREAMING" && link.language !== "English") continue;
    const key = Object.keys(PLATFORM_STYLES).find(p => (link.site || "").toLowerCase().includes(p));
    if (key && !seen.has(key)) {
      seen.add(key);
      platforms.push({ key, url: link.url, ...PLATFORM_STYLES[key] });
    }
  }
  return platforms.slice(0, 4);
}

// ─── AnimeCard ────────────────────────────────────────────────────────────────
function AnimeCard({ anime }) {
  const [hovered, setHovered] = useState(false);
  const img = anime.coverImage?.large || anime.coverImage?.medium;
  const score = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : "N/A";
  const title = anime.title?.english || anime.title?.romaji || "Unknown";
  const studio = anime.studios?.nodes?.[0]?.name || "";
  const eps = anime.episodes ? `${anime.episodes} eps` : "? eps";
  const dub = DUB_LABELS[anime.dubStatus] || DUB_LABELS.unknown;
  const statusInfo = STATUS_LABELS[anime.status] || null;
  const accentColor = anime.coverImage?.color || "#dc2626";
  const platforms = getStreamingPlatforms(anime);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: "10px", overflow: "hidden", cursor: "pointer",
        background: "#0f0f0f", border: `1px solid ${hovered ? accentColor + "55" : "rgba(255,255,255,0.06)"}`,
        transition: "transform 0.25s ease, box-shadow 0.25s ease, border-color 0.2s ease",
        transform: hovered ? "translateY(-6px) scale(1.02)" : "translateY(0) scale(1)",
        boxShadow: hovered ? `0 20px 40px ${accentColor}33, 0 0 0 1px ${accentColor}44` : "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "2/3", overflow: "hidden" }}>
        {img
          ? <img src={img} alt={title} style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.3s ease", transform: hovered ? "scale(1.08)" : "scale(1)" }} />
          : <div style={{ width: "100%", height: "100%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "40px", color: "#333" }}>◈</div>
        }
        <div style={{ position: "absolute", inset: 0, background: hovered ? "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.15) 60%, transparent 100%)" : "linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 60%)", transition: "background 0.3s" }} />

        {/* Dub badge — top right */}
        <div style={{ position: "absolute", top: 8, right: 8, background: dub.bg, color: dub.color, fontSize: "9px", fontWeight: 800, padding: "2px 6px", borderRadius: "4px", letterSpacing: "0.06em", backdropFilter: "blur(4px)" }}>
          {dub.text}
        </div>

        <div style={{ position: "absolute", bottom: 8, left: 8, right: 8, opacity: hovered ? 1 : 0, transition: "opacity 0.25s", fontSize: "11px", color: "rgba(255,255,255,0.75)", lineHeight: 1.5 }}>
          {studio && <div>{studio}</div>}
          <div>{eps} · {anime.format || "TV"}</div>
        </div>
      </div>

      <div style={{ padding: "10px 12px 12px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#f0f0f0", lineHeight: 1.3, marginBottom: "6px", fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.02em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", color: "#f59e0b", fontWeight: 700, fontFamily: "monospace" }}>★ {score}</span>
          {anime.startDate?.year && <span style={{ fontSize: "11px", color: "#555" }}>{anime.seasonYear || anime.startDate.year}</span>}
          {statusInfo && <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "3px", fontWeight: 600, background: statusInfo.bg, color: statusInfo.color }}>{statusInfo.text}</span>}
        </div>
        {anime.genres?.length > 0 && (
          <div style={{ marginTop: "6px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {anime.genres.slice(0, 3).map(g => <span key={g} style={{ fontSize: "10px", color: "#6b7280", background: "rgba(255,255,255,0.04)", padding: "1px 5px", borderRadius: "3px" }}>{g}</span>)}
          </div>
        )}

        {/* Streaming platform pills */}
        {platforms.length > 0 && (
          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {platforms.map(p => (
              <a key={p.key} href={p.url} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ textDecoration: "none" }}
                title={p.key.charAt(0).toUpperCase() + p.key.slice(1)}
              >
                <span style={{
                  display: "inline-block", fontSize: "9px", fontWeight: 800,
                  padding: "2px 6px", borderRadius: "4px", letterSpacing: "0.04em",
                  background: p.color + "22", color: p.color,
                  border: `1px solid ${p.color}44`,
                  transition: "background 0.15s",
                  fontFamily: "monospace",
                }}>{p.label}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingGrid({ count = 12 }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "16px" }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ borderRadius: "10px", overflow: "hidden", background: "#0f0f0f", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ aspectRatio: "2/3", background: "linear-gradient(90deg, #111 25%, #1a1a1a 50%, #111 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite" }} />
          <div style={{ padding: "10px 12px 12px" }}>
            <div style={{ height: "12px", background: "#1a1a1a", borderRadius: "3px", marginBottom: "8px" }} />
            <div style={{ height: "10px", background: "#151515", borderRadius: "3px", width: "60%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────
function FilterBar({ dubFilter, onDubFilter }) {
  const filters = [
    { id: "all",          label: "All" },
    { id: "dubbed",       label: "Dubbed" },
    { id: "likely_dubbed",label: "Likely Dub" },
    { id: "sub_only",     label: "Sub Only" },
    { id: "unknown",      label: "Unknown" },
  ];
  return (
    <div style={{ display: "flex", gap: "6px", marginBottom: "20px", flexWrap: "wrap" }}>
      {filters.map(f => (
        <button key={f.id} onClick={() => onDubFilter(f.id)} style={{
          background: dubFilter === f.id ? "rgba(220,38,38,0.2)" : "rgba(255,255,255,0.04)",
          border: dubFilter === f.id ? "1px solid rgba(220,38,38,0.5)" : "1px solid rgba(255,255,255,0.08)",
          color: dubFilter === f.id ? "#f87171" : "#666",
          borderRadius: "6px", padding: "5px 12px", fontSize: "12px", fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", letterSpacing: "0.04em",
        }}>{f.label}</button>
      ))}
    </div>
  );
}

// ─── Sync Banner ──────────────────────────────────────────────────────────────
function SyncBanner({ syncState, onManualSync }) {
  if (!syncState) return null;
  const { syncing, progress, lastSync, totalCount, error } = syncState;
  const pct = progress ? Math.round((progress.taskIndex / progress.taskTotal) * 100) : 0;

  return (
    <div style={{ background: syncing ? "rgba(220,38,38,0.07)" : "rgba(0,0,0,0.35)", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: syncing ? "12px 24px" : "7px 24px" }}>
      <div style={{ maxWidth: "1100px", margin: "0 auto" }}>
        {syncing ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
              <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#dc2626", animation: "pulse 1s infinite", flexShrink: 0 }} />
              <span style={{ fontSize: "12px", color: "#f87171", fontWeight: 600 }}>SYNCING — {progress?.phase || "Initializing..."}</span>
              <span style={{ fontSize: "11px", color: "#444", marginLeft: "auto", fontFamily: "monospace" }}>{(progress?.fetched || 0).toLocaleString()} titles</span>
            </div>
            <div style={{ height: "3px", background: "#150505", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: "2px", background: "linear-gradient(90deg, #7f1d1d, #dc2626, #f87171)", width: `${pct}%`, transition: "width 0.5s ease" }} />
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {error
              ? <span style={{ fontSize: "11px", color: "#f87171" }}>⚠ {error}</span>
              : <span style={{ fontSize: "11px", color: "#444" }}>
                  <span style={{ color: "#4ade80" }}>✓ </span>
                  {(totalCount || 0).toLocaleString()} titles · AniList GraphQL
                  {lastSync ? ` · synced ${new Date(lastSync).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
                </span>
            }
            <button onClick={onManualSync} style={{
              marginLeft: "auto", background: "transparent",
              border: "1px solid rgba(220,38,38,0.3)", color: "#dc2626",
              borderRadius: "5px", padding: "3px 10px", fontSize: "11px",
              fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>↻ Refresh DB</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ShowCard (calendar) ──────────────────────────────────────────────────────
function ShowCard({ title, epNum, img, streamEntries, primaryUrl, primaryColor, isAiringNow, isMobile }) {
  const [touched, setTouched] = useState(false);
  const [hovered, setHovered] = useState(false);
  const accentColor = primaryColor && primaryColor !== "#555" ? primaryColor : null;

  // ── Mobile poster card ───────────────────────────────────────────────────────
  if (isMobile) {
    const revealed = touched || hovered;
    const mobileCard = (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={() => setTouched(t => !t)}
        style={{
          position: "relative",
          borderRadius: "10px",
          overflow: "hidden",
          cursor: primaryUrl ? "pointer" : "default",
          border: `1px solid ${isAiringNow ? "rgba(220,38,38,0.4)" : "rgba(255,255,255,0.07)"}`,
          boxShadow: isAiringNow ? "0 0 16px rgba(220,38,38,0.2)" : "0 4px 16px rgba(0,0,0,0.5)",
          userSelect: "none",
          aspectRatio: "2/3",
          background: "#111",
        }}
      >
        {/* Poster image — full card */}
        {img ? (
          <img
            src={img} alt={title}
            style={{
              width: "100%", height: "100%", objectFit: "cover", display: "block",
              transition: "transform 0.35s ease",
              transform: revealed ? "scale(1.06)" : "scale(1)",
            }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "32px", color: "#333" }}>◈</div>
        )}

        {/* Persistent gradient + title at top */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0,
          background: "linear-gradient(to bottom, rgba(0,0,0,0.82) 0%, transparent 100%)",
          padding: "10px 10px 20px",
        }}>
          <div style={{
            fontSize: "12px", fontWeight: 700, color: "#fff",
            fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.03em",
            lineHeight: 1.25,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}>{title}</div>
          {epNum && (
            <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.5)", fontFamily: "monospace", marginTop: "2px" }}>Ep {epNum}</div>
          )}
        </div>

        {/* Slide-in stream logos overlay from bottom on touch/hover */}
        {streamEntries.length > 0 && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            background: "linear-gradient(to top, rgba(0,0,0,0.95) 60%, transparent 100%)",
            padding: "20px 10px 10px",
            transform: revealed ? "translateY(0)" : "translateY(100%)",
            transition: "transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
            display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "flex-end",
          }}>
            {streamEntries.map(([site, url]) => {
              const color = getStreamColor(site);
              return (
                <a key={site} href={url} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  style={{ textDecoration: "none" }}
                >
                  <span style={{
                    fontSize: "9px", fontWeight: 800, padding: "3px 7px",
                    borderRadius: "4px", fontFamily: "monospace", letterSpacing: "0.05em",
                    background: color + "33",
                    color: color,
                    border: `1px solid ${color}88`,
                    display: "inline-block",
                  }}>{site}</span>
                </a>
              );
            })}
          </div>
        )}

        {/* LIVE NOW badge */}
        {isAiringNow && (
          <div style={{
            position: "absolute", top: 8, right: 8,
            background: "rgba(220,38,38,0.9)", color: "#fff",
            fontSize: "8px", fontWeight: 800, padding: "2px 6px",
            borderRadius: "3px", letterSpacing: "0.07em",
            display: "flex", alignItems: "center", gap: "4px",
          }}>
            <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#fff", animation: "pulse 1s infinite", display: "inline-block" }} />
            LIVE
          </div>
        )}
      </div>
    );

    if (primaryUrl) {
      return (
        <a href={primaryUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
          {mobileCard}
        </a>
      );
    }
    return mobileCard;
  }

  // ── Desktop row card ─────────────────────────────────────────────────────────
  const hoverBg     = accentColor ? `${accentColor}18` : "rgba(255,255,255,0.04)";
  const hoverBorder = accentColor ? `${accentColor}66` : "rgba(255,255,255,0.15)";

  const desktopCard = (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? hoverBg : "#0f0f0f",
        border: `1px solid ${hovered ? hoverBorder : isAiringNow ? "rgba(220,38,38,0.3)" : "rgba(255,255,255,0.06)"}`,
        borderRadius: "9px", overflow: "hidden",
        display: "flex", alignItems: "stretch",
        cursor: primaryUrl ? "pointer" : "default",
        transition: "background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease",
        boxShadow: hovered && accentColor ? `0 4px 24px ${accentColor}22` : isAiringNow ? "0 0 16px rgba(220,38,38,0.1)" : "none",
        userSelect: "none",
      }}
    >
      {/* Cover image */}
      {img && (
        <div style={{ width: "48px", flexShrink: 0, overflow: "hidden", position: "relative" }}>
          <img src={img} alt={title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transition: "transform 0.3s ease", transform: hovered ? "scale(1.08)" : "scale(1)" }} />
          {hovered && accentColor && <div style={{ position: "absolute", inset: 0, background: `${accentColor}33` }} />}
        </div>
      )}

      {/* Info */}
      <div style={{ flex: 1, padding: "11px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "5px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span style={{
            fontSize: "14px", fontWeight: 700,
            color: hovered ? "#fff" : "#e0e0e0",
            fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.02em", lineHeight: 1.2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            transition: "color 0.15s",
          }}>{title}</span>
          {epNum && (
            <span style={{ flexShrink: 0, fontSize: "11px", color: hovered && accentColor ? accentColor : "#444", fontFamily: "monospace", fontWeight: 600, transition: "color 0.15s" }}>
              Ep {epNum}
            </span>
          )}
        </div>

        {/* Stream pills */}
        {streamEntries.length > 0 && (
          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
            {streamEntries.map(([site, url]) => {
              const color = getStreamColor(site);
              return (
                <a key={site} href={url} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  style={{ textDecoration: "none" }}
                  title={`Watch on ${site}`}
                >
                  <span style={{
                    fontSize: "10px", fontWeight: 700, padding: "2px 7px",
                    borderRadius: "4px", fontFamily: "monospace", letterSpacing: "0.03em",
                    background: hovered ? color + "33" : color + "18",
                    color: color,
                    border: `1px solid ${hovered ? color + "88" : color + "44"}`,
                    transition: "background 0.15s, border-color 0.15s",
                    display: "inline-block",
                  }}>{site}</span>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {/* Arrow on hover */}
      {primaryUrl && (
        <div style={{
          flexShrink: 0, display: "flex", alignItems: "center", paddingRight: "14px",
          color: hovered && accentColor ? accentColor : "transparent",
          fontSize: "16px", transition: "color 0.15s",
        }}>›</div>
      )}
    </div>
  );

  if (primaryUrl) {
    return (
      <a href={primaryUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
        {desktopCard}
      </a>
    );
  }
  return desktopCard;
}

// ─── Pages ────────────────────────────────────────────────────────────────────
function AiringPage({ isMobile = false }) {
  const todayIndex = new Date().getDay(); // local day, 0=Sun
  const [activeDay, setActiveDay] = useState(todayIndex);
  const [grouped, setGrouped] = useState(null);
  const [enriched, setEnriched] = useState({}); // { "showRoute": { streams } }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchDubTimetable()
      .then(async data => {
        const shows = Array.isArray(data) ? data : [];
        const g = groupByDay(shows);
        setGrouped(g);
        setLastFetch(Date.now());
        setLoading(false);

        // Enrich all shows with streaming links in background (after page is visible)
        try {
          const allShows = Object.values(g).flat();
          const enrichMap = {};
          await Promise.all(allShows.map(async show => {
            try {
              const links = await getShowLinks(show);
              enrichMap[show.route || show.title] = links;
            } catch {
              enrichMap[show.route || show.title] = {};
            }
          }));
          setEnriched(enrichMap);
        } catch { /* enrichment failure is non-fatal */ }
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  const todayShows = grouped?.[DAYS[activeDay]] || [];

  // Build a date label for each day tab based on the current week
  const now = new Date();
  const weekDates = DAYS.map((_, i) => {
    const d = new Date(now);
    const diff = i - now.getUTCDay();
    d.setUTCDate(now.getUTCDate() + diff);
    return d;
  });

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "28px", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, color: "#fff", marginBottom: "5px", letterSpacing: "0.05em" }}>
          Weekly Dub Calendar
        </h2>
        <p style={{ color: "#555", fontSize: "13px" }}>
          English dub air schedule · times in your local timezone
          {lastFetch ? ` · updated ${new Date(lastFetch).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
        </p>
      </div>

      {/* Day tabs */}
      <div style={{
        display: "flex", gap: isMobile ? "4px" : "6px", marginBottom: "24px",
        overflowX: "auto", paddingBottom: "4px",
        scrollbarWidth: "none",
      }}>
        {DAYS.map((day, i) => {
          const isToday = i === todayIndex;
          const isActive = i === activeDay;
          const count = grouped?.[day]?.length || 0;
          const tabDate = weekDates[i];
          const dateLabel = tabDate.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
          return (
            <button key={day} onClick={() => setActiveDay(i)} style={{
              flexShrink: 0,
              background: isActive ? "#dc2626" : isToday ? "rgba(220,38,38,0.1)" : "rgba(255,255,255,0.04)",
              border: isActive ? "1px solid #dc2626" : isToday ? "1px solid rgba(220,38,38,0.35)" : "1px solid rgba(255,255,255,0.08)",
              color: isActive ? "#fff" : isToday ? "#f87171" : "#555",
              borderRadius: "8px",
              padding: isMobile ? "7px 8px" : "9px 14px",
              cursor: "pointer", fontFamily: "inherit",
              transition: "all 0.15s",
              display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
              minWidth: isMobile ? "48px" : "72px",
            }}>
              <span style={{ fontSize: isMobile ? "11px" : "12px", fontWeight: 700, letterSpacing: "0.04em" }}>
                {DAY_LABELS[i]}
              </span>
              <span style={{ fontSize: isMobile ? "10px" : "11px", fontWeight: 500, opacity: isActive ? 0.85 : 0.5 }}>
                {dateLabel}
              </span>
              {!loading && (
                <span style={{
                  fontSize: "10px", fontWeight: 600,
                  color: isActive ? "rgba(255,255,255,0.75)" : "#333",
                  fontFamily: "monospace",
                }}>{count}</span>
              )}
              {isToday && !isActive && (
                <span style={{ width: "4px", height: "4px", borderRadius: "50%", background: "#dc2626", marginTop: "1px" }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Error state */}
      {error && (
        <div style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.25)", borderRadius: "10px", padding: "20px", marginBottom: "20px" }}>
          <div style={{ color: "#f87171", fontWeight: 700, marginBottom: "6px", fontSize: "13px" }}>⚠ Could not load schedule</div>
          <div style={{ color: "#555", fontSize: "12px", marginBottom: "12px" }}>{error}</div>
          <div style={{ color: "#444", fontSize: "12px", lineHeight: 1.6 }}>
            Make sure <code style={{ color: "#f87171", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: "3px" }}>VITE_ANIMESCHEDULE_KEY</code> is set in your <code style={{ color: "#f87171", background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: "3px" }}>.env</code> file and restart the dev server.
          </div>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ height: "80px", borderRadius: "10px", background: "linear-gradient(90deg, #111 25%, #1a1a1a 50%, #111 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite" }} />
          ))}
        </div>
      )}

      {/* Shows list — grouped by time */}
      {!loading && !error && (
        <>
          {todayShows.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#333" }}>
              <div style={{ fontSize: "40px", marginBottom: "12px", opacity: 0.3 }}>◷</div>
              <p style={{ fontSize: "14px" }}>No dubbed shows airing on {DAY_LABELS[activeDay]}</p>
            </div>
          ) : (() => {
            // Group shows by time slot
            const byTime = {};
            todayShows.forEach(show => {
              const epDate = new Date(show.episodeDate || show.EpisodeDate);
              const timeStr = isNaN(epDate) ? "Unknown" : epDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
              if (!byTime[timeStr]) byTime[timeStr] = [];
              byTime[timeStr].push(show);
            });

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
                {Object.entries(byTime).map(([timeStr, shows]) => {
                  const firstDate = new Date(shows[0].episodeDate || shows[0].EpisodeDate);
                  const isAiringNow = !isNaN(firstDate) && Math.abs(Date.now() - firstDate.getTime()) < 60 * 60 * 1000;

                  return (
                    <div key={timeStr}>
                      {/* Time header */}
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          {isAiringNow && <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#dc2626", animation: "pulse 1s infinite", flexShrink: 0 }} />}
                          <span style={{
                            fontFamily: "monospace", fontSize: isMobile ? "14px" : "16px", fontWeight: 700,
                            color: isAiringNow ? "#f87171" : "#e0e0e0",
                            letterSpacing: "0.05em",
                          }}>{timeStr}</span>
                          {isAiringNow && (
                            <span style={{ fontSize: "10px", background: "rgba(220,38,38,0.2)", color: "#f87171", padding: "1px 7px", borderRadius: "3px", fontWeight: 700, letterSpacing: "0.06em" }}>LIVE</span>
                          )}
                        </div>
                        <div style={{ flex: 1, height: "1px", background: isAiringNow ? "rgba(220,38,38,0.25)" : "rgba(255,255,255,0.06)" }} />
                        <span style={{ fontSize: "11px", color: "#333", fontFamily: "monospace" }}>{shows.length} show{shows.length !== 1 ? "s" : ""}</span>
                      </div>

                      {/* Show cards for this time slot */}
                      <div style={{
                        display: isMobile ? "grid" : "flex",
                        gridTemplateColumns: isMobile ? "repeat(auto-fill, minmax(110px, 1fr))" : undefined,
                        flexDirection: isMobile ? undefined : "column",
                        gap: isMobile ? "10px" : "6px",
                      }}>
                        {shows.map((show, i) => {
                          const title = show.english || show.romaji || show.title || "Unknown";
                          const epNum = show.episodeNumber;
                          const img = show.imageVersionRoute
                            ? `https://cdn.animeschedule.net/production/assets/public/img/${show.imageVersionRoute}`
                            : null;
                          const key = show.route || show.title;
                          const streams = enriched[key] || show.streams || {};
                          const streamEntries = Object.entries(streams).filter(([, url]) => typeof url === "string" && url.startsWith("http"));
                          const primarySite = streamEntries[0]?.[0] || "";
                          const primaryUrl = streamEntries[0]?.[1] || null;
                          const primaryColor = getStreamColor(primarySite);

                          return (
                            <ShowCard
                              key={i}
                              title={title}
                              epNum={epNum}
                              img={img}
                              streamEntries={streamEntries}
                              primaryUrl={primaryUrl}
                              primaryColor={primaryColor}
                              isAiringNow={isAiringNow}
                              isMobile={isMobile}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                <div style={{ fontSize: "11px", color: "#2a2a2a", fontFamily: "monospace", textAlign: "right" }}>
                  {todayShows.length} dubs · {DAY_LABELS[activeDay]} · cached weekly
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

function UpcomingPage({ gridMinCard = "160px" }) {
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [dubFilter, setDubFilter] = useState("all");

  useEffect(() => {
    sbAnime.getAll({ status: "NOT_YET_RELEASED" }).then(items => {
      const upcoming = items.sort((a, b) => {
        const da = a.startDate?.year ? new Date(a.startDate.year, (a.startDate.month||1)-1) : new Date("2099");
        const db_ = b.startDate?.year ? new Date(b.startDate.year, (b.startDate.month||1)-1) : new Date("2099");
        return da - db_;
      });
      const g = {};
      upcoming.forEach(a => {
        const s = a.season && a.seasonYear ? `${a.season} ${a.seasonYear}` : a.startDate?.year ? String(a.startDate.year) : "TBA";
        if (!g[s]) g[s] = [];
        g[s].push(a);
      });
      setGrouped(g);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "28px", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, color: "#fff", marginBottom: "5px", letterSpacing: "0.05em" }}>Upcoming Releases</h2>
        <p style={{ color: "#555", fontSize: "13px" }}>Confirmed upcoming anime · grouped by season</p>
      </div>
      <FilterBar dubFilter={dubFilter} onDubFilter={setDubFilter} />
      {loading ? <LoadingGrid /> : Object.entries(grouped).map(([season, items]) => {
        const filtered = dubFilter === "all" ? items : items.filter(a => a.dubStatus === dubFilter);
        if (filtered.length === 0) return null;
        return (
          <div key={season} style={{ marginBottom: "36px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "15px", fontWeight: 700, color: "#dc2626", letterSpacing: "0.12em", textTransform: "uppercase" }}>{season}</span>
              <div style={{ flex: 1, height: "1px", background: "rgba(220,38,38,0.15)" }} />
              <span style={{ fontSize: "11px", color: "#333" }}>{filtered.length} titles</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${gridMinCard}, 1fr))`, gap: gridMinCard === "130px" ? "10px" : "16px" }}>
              {filtered.slice(0, 16).map(a => <AnimeCard key={a.id} anime={a} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SearchPage({ gridMinCard = "160px", isMobile = false }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbSize, setDbSize] = useState(0);
  const [dubFilter, setDubFilter] = useState("all");
  const [source, setSource] = useState("local"); // "local" | "api"

  useEffect(() => { sbAnime.count().then(setDbSize).catch(() => {}); }, []);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearched(true);
    setLoading(true);
    setResults([]);

    if (source === "local") {
      try {
        const matches = await sbAnime.search(query);
        setResults(matches);
      } catch {
        setResults([]);
      }
    } else {
      try {
        const data = await anilistFetch(SEARCH_QUERY, { search: query, page: 1, perPage: 40 });
        const items = (data?.Page?.media || []).map(m => ({ ...m, dubStatus: detectDubStatus(m), score: m.averageScore || 0 }));
        setResults(items);
      } catch (e) {
        setResults([]);
      }
    }
    setLoading(false);
  }, [query, source]);

  const filtered = dubFilter === "all" ? results : results.filter(a => a.dubStatus === dubFilter);

  return (
    <div>
      <div style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "28px", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, color: "#fff", marginBottom: "5px", letterSpacing: "0.05em" }}>Search Anime</h2>
        <p style={{ color: "#555", fontSize: "13px" }}>
          {source === "local" ? `Searching ${dbSize.toLocaleString()} titles in Supabase` : "Live search via AniList API"}
        </p>
      </div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexDirection: isMobile ? "column" : "row" }}>
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && doSearch()}
          placeholder="Search by title..."
          style={{ flex: 1, background: "#0f0f0f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: isMobile ? "14px 16px" : "12px 16px", color: "#fff", fontSize: "15px", outline: "none", fontFamily: "inherit", transition: "border-color 0.2s" }}
          onFocus={e => e.target.style.borderColor = "rgba(220,38,38,0.6)"}
          onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
        />
        <button onClick={doSearch} style={{ ...btnStyle, padding: isMobile ? "14px" : "12px 24px", fontSize: "15px" }}>Search</button>
      </div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "#444" }}>Source:</span>
        {["local","api"].map(s => (
          <button key={s} onClick={() => setSource(s)} style={{
            background: source === s ? "rgba(220,38,38,0.15)" : "transparent",
            border: source === s ? "1px solid rgba(220,38,38,0.4)" : "1px solid rgba(255,255,255,0.08)",
            color: source === s ? "#f87171" : "#555",
            borderRadius: "5px", padding: "4px 10px", fontSize: "11px",
            fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{s === "local" ? "Local DB" : "Live API"}</button>
        ))}
      </div>
      {searched && <FilterBar dubFilter={dubFilter} onDubFilter={setDubFilter} />}
      {loading && <LoadingGrid count={8} />}
      {!loading && searched && filtered.length === 0 && <div style={{ textAlign: "center", color: "#333", padding: "60px 0" }}>No results found for "{query}"</div>}
      {!loading && filtered.length > 0 && (
        <>
          <div style={{ marginBottom: "14px", fontSize: "12px", color: "#444", fontFamily: "monospace" }}>{filtered.length} results</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${gridMinCard}, 1fr))`, gap: gridMinCard === "130px" ? "10px" : "16px" }}>
            {filtered.map(a => <AnimeCard key={a.id} anime={a} />)}
          </div>
        </>
      )}
      {!searched && (
        <div style={{ textAlign: "center", padding: "80px 0" }}>
          <div style={{ fontSize: "64px", marginBottom: "16px", opacity: 0.08 }}>⌕</div>
          <p style={{ color: "#2a2a2a", fontSize: "14px" }}>Search locally or live via AniList API</p>
        </div>
      )}
    </div>
  );
}

function WatchPage({ isMobile = false }) {
  return (
    <div>
      <div style={{ marginBottom: "28px" }}>
        <h2 style={{ fontSize: "28px", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, color: "#fff", marginBottom: "5px", letterSpacing: "0.05em" }}>Where to Watch</h2>
        <p style={{ color: "#555", fontSize: "13px" }}>Major streaming platforms with English dubbed anime</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px", marginBottom: "32px" }}>
        {STREAMING.map(s => (
          <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ background: "#0f0f0f", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "20px 22px", transition: "all 0.2s ease", cursor: "pointer" }}
              onMouseEnter={e => { e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.borderColor=s.color+"55"; e.currentTarget.style.boxShadow=`0 12px 30px ${s.color}1a`; }}
              onMouseLeave={e => { e.currentTarget.style.transform="translateY(0)"; e.currentTarget.style.borderColor="rgba(255,255,255,0.07)"; e.currentTarget.style.boxShadow="none"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "10px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "9px", background: s.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 900, color: "#fff", fontFamily: "monospace", flexShrink: 0 }}>{s.logo}</div>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 700, color: "#f0f0f0", fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.03em" }}>{s.name}</div>
                  <div style={{ fontSize: "10px", color: "#444" }}>↗ {s.url.replace("https://","")}</div>
                </div>
              </div>
              <p style={{ fontSize: "13px", color: "#777", lineHeight: 1.5, margin: 0 }}>{s.desc}</p>
            </div>
          </a>
        ))}
      </div>

      {/* Dub status legend */}
      <div style={{ background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "10px", padding: "18px 20px" }}>
        <div style={{ fontSize: "13px", color: "#dc2626", fontWeight: 700, marginBottom: "12px", fontFamily: "'Rajdhani', sans-serif", letterSpacing: "0.05em" }}>DUB STATUS LEGEND</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "10px" }}>
          {Object.entries(DUB_LABELS).map(([key, val]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ background: val.bg, color: val.color, fontSize: "10px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", letterSpacing: "0.05em" }}>{val.text}</span>
              <span style={{ fontSize: "12px", color: "#555" }}>
                {key === "dubbed"        && "English streaming links confirmed"}
                {key === "likely_dubbed" && "Funimation/HIDIVE link detected"}
                {key === "sub_only"      && "No English streaming links found"}
                {key === "unknown"       && "No streaming data available"}
              </span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: "12px", color: "#333", marginTop: "12px", lineHeight: 1.6, margin: "12px 0 0" }}>
          Dub status is inferred from AniList's external link data. Always verify on the platform directly.
        </p>
      </div>
    </div>
  );
}

function Pagination({ page, totalPages, setPage }) {
  return (
    <div style={{ display: "flex", gap: "8px", justifyContent: "center", alignItems: "center", marginTop: "32px" }}>
      <button onClick={() => setPage(1)} disabled={page===1} style={{ ...btnStyle, padding: "8px 12px", opacity: page===1?0.35:1 }}>«</button>
      <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1} style={{ ...btnStyle, padding: "8px 14px", opacity: page===1?0.35:1 }}>‹</button>
      <span style={{ color: "#444", fontSize: "13px", fontFamily: "monospace", padding: "0 10px" }}>{page} / {totalPages}</span>
      <button onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page===totalPages} style={{ ...btnStyle, padding: "8px 14px", opacity: page===totalPages?0.35:1 }}>›</button>
      <button onClick={() => setPage(totalPages)} disabled={page===totalPages} style={{ ...btnStyle, padding: "8px 12px", opacity: page===totalPages?0.35:1 }}>»</button>
    </div>
  );
}

function FirstRunOverlay({ progress, isMobile = false }) {
  const pct = progress ? Math.round((progress.taskIndex / progress.taskTotal) * 100) : 2;
  return (
    <div style={{ position: "fixed", inset: 0, background: "#080808", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "28px", padding: "24px" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: isMobile ? "32px" : "40px", fontWeight: 700, color: "#fff", letterSpacing: "0.12em", marginBottom: "10px" }}>ANIME<span style={{ color: "#dc2626" }}>DUB</span></div>
        <div style={{ fontSize: "14px", color: "#444" }}>Syncing anime database from AniList to Supabase…</div>
      </div>
      <div style={{ width: isMobile ? "100%" : "360px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
          <span style={{ fontSize: "11px", color: "#777", maxWidth: "80%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{progress?.phase || "Connecting to AniList..."}</span>
          <span style={{ fontSize: "12px", color: "#dc2626", fontFamily: "monospace" }}>{pct}%</span>
        </div>
        <div style={{ height: "4px", background: "#120505", borderRadius: "2px", overflow: "hidden" }}>
          <div style={{ height: "100%", borderRadius: "2px", background: "linear-gradient(90deg, #7f1d1d, #dc2626, #f87171)", width: `${pct}%`, transition: "width 0.6s ease" }} />
        </div>
        <div style={{ marginTop: "10px", fontSize: "11px", color: "#2a2a2a", fontFamily: "monospace", textAlign: "center" }}>
          {(progress?.fetched || 0).toLocaleString()} titles fetched
        </div>
      </div>
      <p style={{ fontSize: "11px", color: "#1e1e1e", maxWidth: "300px", textAlign: "center", lineHeight: 1.7 }}>
        First-time setup takes ~5 minutes due to AniList rate limits. Stored in Supabase and auto-refreshed weekly.
      </p>
    </div>
  );
}

// ─── Breakpoint Hook ──────────────────────────────────────────────────────────
function useBreakpoint() {
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return { isMobile: width < 601, isTablet: width >= 601 && width < 900, isDesktop: width >= 900, width };
}

// ─── Mobile Bottom Nav ────────────────────────────────────────────────────────
function MobileNav({ page, setPage }) {
  return (
    <nav style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
      background: "rgba(8,8,8,0.98)", backdropFilter: "blur(16px)",
      borderTop: "1px solid rgba(220,38,38,0.15)",
      display: "flex", alignItems: "stretch",
      paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      {NAV.map(n => {
        const active = page === n.id;
        return (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            flex: 1, background: "transparent", border: "none",
            color: active ? "#f87171" : "#444",
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: "3px", padding: "10px 4px",
            cursor: "pointer", fontFamily: "inherit",
            borderTop: active ? "2px solid #dc2626" : "2px solid transparent",
            transition: "color 0.15s, border-color 0.15s",
          }}>
            <span style={{ fontSize: "16px", lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {n.label.split(" ")[0]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("airing");
  const [syncState, setSyncState] = useState({ syncing: false, progress: null, lastSync: null, totalCount: 0, error: null });
  const [firstRun, setFirstRun] = useState(false);
  const syncingRef = useRef(false);
  const { isMobile, isTablet } = useBreakpoint();

  const startSync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncState(s => ({ ...s, syncing: true, progress: null, error: null }));
    try {
      const count = await runFullSync(progress => {
        setSyncState(s => ({ ...s, syncing: true, progress }));
      });
      setSyncState({ syncing: false, progress: null, lastSync: Date.now(), totalCount: count, error: null });
    } catch (e) {
      setSyncState(s => ({ ...s, syncing: false, error: e.message }));
    }
    syncingRef.current = false;
    setFirstRun(false);
  }, []);

  useEffect(() => {
    checkNeedsSync().then(({ needsSync, firstRun: fr, lastSync, totalCount }) => {
      setSyncState({ syncing: false, progress: null, lastSync, totalCount, error: null });
      if (needsSync) {
        if (fr) setFirstRun(true);
        startSync();
      }
    }).catch(e => setSyncState(s => ({ ...s, error: "Supabase error: " + e.message })));
  }, [startSync]);

  const manualSync = useCallback(() => startSync(), [startSync]);

  const headerPad   = isMobile ? "0 12px" : "0 24px";
  const mainPad     = isMobile ? "16px 12px 100px" : isTablet ? "24px 16px 80px" : "32px 24px 80px";
  const gridMinCard = isMobile ? "130px" : isTablet ? "145px" : "160px";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Nunito:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080808; -webkit-text-size-adjust: 100%; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #080808; }
        ::-webkit-scrollbar-thumb { background: #1f0505; border-radius: 3px; }
        @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.25} }
        input, button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
      `}</style>

      {firstRun && <FirstRunOverlay progress={syncState.progress} isMobile={isMobile} />}

      <div style={{ minHeight: "100vh", background: "#080808", fontFamily: "'Nunito', sans-serif", color: "#e0e0e0" }}>

        {/* Header */}
        <header style={{ background: "rgba(8,8,8,0.97)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(220,38,38,0.12)", position: "sticky", top: 0, zIndex: 100, padding: headerPad }}>
          <div style={{ maxWidth: "1100px", margin: "0 auto", height: "56px", display: "flex", alignItems: "center", gap: isMobile ? "0" : "28px", justifyContent: isMobile ? "space-between" : "flex-start" }}>

            {/* Logo */}
            <div style={{ display: "flex", alignItems: "center", gap: "9px", flexShrink: 0 }}>
              <div style={{ width: "28px", height: "28px", background: "#dc2626", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, color: "#fff", fontFamily: "'Rajdhani',sans-serif", fontSize: "15px" }}>A</div>
              <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "19px", fontWeight: 700, color: "#fff", letterSpacing: "0.08em" }}>ANIME<span style={{ color: "#dc2626" }}>DUB</span></span>
            </div>

            {/* Desktop/Tablet nav — hidden on mobile (uses bottom nav instead) */}
            {!isMobile && (
              <nav style={{ display: "flex", gap: "4px", flex: 1 }}>
                {NAV.map(n => (
                  <button key={n.id} onClick={() => setPage(n.id)} style={{
                    background: page===n.id ? "rgba(220,38,38,0.12)" : "transparent",
                    border: page===n.id ? "1px solid rgba(220,38,38,0.3)" : "1px solid transparent",
                    color: page===n.id ? "#f87171" : "#555",
                    borderRadius: "6px", padding: isTablet ? "5px 10px" : "5px 13px",
                    fontSize: isTablet ? "12px" : "13px", fontWeight: 600,
                    cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                    letterSpacing: "0.03em", display: "flex", alignItems: "center", gap: "5px",
                    whiteSpace: "nowrap",
                  }}>
                    <span style={{ fontSize: "11px" }}>{n.icon}</span>
                    {isTablet ? n.label.split(" ")[0] : n.label}
                  </button>
                ))}
              </nav>
            )}

            {/* Sync refresh button in header on mobile */}
            {isMobile && (
              <button onClick={manualSync} style={{
                background: "transparent", border: "1px solid rgba(220,38,38,0.3)",
                color: "#dc2626", borderRadius: "6px", padding: "6px 10px",
                fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
              }}>↻</button>
            )}
          </div>
        </header>

        <div style={{ height: "2px", background: "linear-gradient(90deg, #dc2626, #7f1d1d 40%, transparent)" }} />

        {/* Sync banner — hide on mobile to save space, button is in header */}
        {!isMobile && <SyncBanner syncState={syncState} onManualSync={manualSync} />}

        {/* Slim mobile sync status bar */}
        {isMobile && syncState.syncing && (
          <div style={{ background: "rgba(220,38,38,0.08)", padding: "6px 12px", borderBottom: "1px solid rgba(220,38,38,0.15)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#dc2626", animation: "pulse 1s infinite" }} />
              <span style={{ fontSize: "11px", color: "#f87171", fontWeight: 600 }}>{syncState.progress?.phase || "Syncing..."}</span>
              <span style={{ fontSize: "10px", color: "#444", marginLeft: "auto", fontFamily: "monospace" }}>{(syncState.progress?.fetched||0).toLocaleString()}</span>
            </div>
            <div style={{ height: "2px", background: "#150505", borderRadius: "1px", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg,#dc2626,#f87171)", width: `${syncState.progress ? Math.round((syncState.progress.taskIndex/syncState.progress.taskTotal)*100) : 0}%`, transition: "width 0.4s" }} />
            </div>
          </div>
        )}

        <main
          style={{ maxWidth: "1100px", margin: "0 auto", padding: mainPad, animation: "fadeIn 0.3s ease" }}
          key={page}
        >
          {page === "airing"   && <AiringPage   isMobile={isMobile} />}
          {page === "upcoming" && <UpcomingPage gridMinCard={gridMinCard} />}
          {page === "search"   && <SearchPage   gridMinCard={gridMinCard} isMobile={isMobile} />}
          {page === "watch"    && <WatchPage isMobile={isMobile} />}
        </main>

        {!isMobile && (
          <footer style={{ borderTop: "1px solid rgba(255,255,255,0.04)", padding: "18px 24px", textAlign: "center", color: "#1e1e1e", fontSize: "11px", fontFamily: "monospace" }}>
            AnimeDub · Supabase · AniList GraphQL API · {new Date().getFullYear()}
          </footer>
        )}

        {/* Mobile bottom nav */}
        {isMobile && <MobileNav page={page} setPage={setPage} />}
      </div>
    </>
  );
}