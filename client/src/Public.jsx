// Site public : les visiteurs écoutent et notent les titres de RGM.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

// ======================================================= Infos du studio (à modifier ici)
const STUDIO = {
  tagline: "Produit et mixé avec le coeur",
  about: [
    "RGM, Real Ghetto Man, est un studio de production et un DJ. Chaque titre présenté ici a été composé, enregistré et mixé par l'équipe.",
    "Écoutez les morceaux, laissez une note, revenez quand de nouveaux titres sortent.",
  ],
  email: "contact@rgm.example",
  links: [], // exemple : [{ label: "Instagram", href: "https://instagram.com/..." }]
};

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ======================================================= Petits composants
function Cover({ url, size = "" }) {
  return url ? (
    <img className={`cover ${size}`} src={url} alt="" loading="lazy" />
  ) : (
    <div className={`cover empty ${size}`} aria-hidden="true">RGM</div>
  );
}

function Stars({ avg, mine, onRate }) {
  const [hover, setHover] = useState(0);
  const lit = hover || mine || Math.round(avg || 0);
  const personal = Boolean(hover || mine);
  return (
    <span className="stars" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= lit ? (personal ? "on mine" : "on") : ""}
          aria-label={`Noter ${n} sur 5`}
          onMouseEnter={() => setHover(n)}
          onClick={(e) => { e.stopPropagation(); onRate(n); }}
        >★</button>
      ))}
    </span>
  );
}

const PlayIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>;
const PrevIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12 18 6v12z" /></svg>;
const NextIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18V6l8.5 6z" /></svg>;

// ======================================================= Page
export default function Public() {
  const audioRef = useRef(null);
  const [tracks, setTracks] = useState(null);       // null = chargement
  const [error, setError] = useState("");
  const [tab, setTab] = useState("titres");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [favorites, setFavorites] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("rgm_favorites") || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [currentId, setCurrentId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    api.tracks().then(setTracks).catch(() => setError("Impossible de charger les titres pour le moment."));
  }, []);

  useEffect(() => {
    localStorage.setItem("rgm_favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (tracks || []).filter((t) =>
      (tab !== "favoris" || favorites.includes(t.id)) &&
      (!q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    );
    return filtered.sort((a, b) => {
      if (sort === "popular") return (b.plays || 0) - (a.plays || 0);
      if (sort === "rated") return (b.rating_avg || 0) - (a.rating_avg || 0);
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
  }, [tracks, query, tab, favorites, sort]);

  const current = (tracks || []).find((t) => t.id === currentId) || null;

  function playTrack(t) {
    const a = audioRef.current;
    if (t.id === currentId) {
      if (a.paused) a.play().catch(() => setError("La lecture de ce titre a échoué."));
      else a.pause();
      return;
    }
    setCurrentId(t.id);
    setTime(0);
    a.src = t.audio_url;
    a.play().catch(() => setError("La lecture de ce titre a échoué."));
    api.play(t.id).catch(() => {});
  }

  function step(dir) {
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === currentId);
    const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    playTrack(list[next]);
  }

  async function rate(t, value) {
    try {
      const updated = await api.rate(t.id, value);
      setTracks((all) => all.map((x) => (x.id === updated.id ? updated : x)));
    } catch { setError("La note n'a pas pu être enregistrée."); }
  }

  function toggleFavorite(id) {
    setFavorites((saved) => saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id]);
  }

  const total = dur || current?.duration || 0;
  return (
    <div className="site">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="RGM, accueil">
          <img src="/logo.jpg" alt="" />
          <span>RGM <small>REAL GHETTO MAN</small></span>
        </a>
        <nav className="side-nav" aria-label="Bibliothèque">
          <button className={tab === "titres" ? "active" : ""} onClick={() => setTab("titres")}>
            <span aria-hidden="true">⌂</span> Accueil
          </button>
          <button className={tab === "favoris" ? "active" : ""} onClick={() => setTab("favoris")}>
            <span aria-hidden="true">♥</span> Titres likés <small>{favorites.length}</small>
          </button>
          <button className={tab === "apropos" ? "active" : ""} onClick={() => setTab("apropos")}>
            <span aria-hidden="true">ⓘ</span> À propos
          </button>
        </nav>
        <p className="sidebar-note">{STUDIO.tagline}</p>
      </aside>

      <div className="app-main">
        <header className="bar">
          <div className="history-buttons" aria-hidden="true"><span>‹</span><span>›</span></div>
          <label className="search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              type="search" className="search" placeholder="Que souhaitez-vous écouter ?"
              value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher dans les titres"
            />
          </label>
        </header>

        <main className="content">
          {tab === "apropos" ? (
            <section className="about">
              <p className="eyebrow">STD</p>
              <h1>RGM <span>Real Ghetto Man</span></h1>
              {STUDIO.about.map((p, i) => <p key={i}>{p}</p>)}
              <p><a href={`mailto:${STUDIO.email}`}>{STUDIO.email}</a></p>
              {STUDIO.links.length > 0 && (
                <p className="links">{STUDIO.links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>)}</p>
              )}
            </section>
          ) : (
            <>
              <section className="welcome">
                <p className="eyebrow">VOTRE MUSIQUE, VOTRE ESPACE</p>
                <h1>{tab === "favoris" ? "Vos titres likés" : "Le Vivre au moment present"}</h1>
                <p>{tab === "favoris" ? "Retrouvez ici les morceaux que vous aimez." : STUDIO.tagline}</p>
              </section>
              {error && <p className="notice" role="alert">{error}</p>}
              <div className="section-heading">
                <div>
                  <h2>{tab === "favoris" ? "Votre bibliothèque" : "Tous les titres"}</h2>
                  <span>{list.length} {list.length === 1 ? "titre" : "titres"}</span>
                </div>
                <label className="sort-label">Trier par
                  <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Trier les titres">
                    <option value="recent">Plus récents</option>
                    <option value="popular">Plus écoutés</option>
                    <option value="rated">Mieux notés</option>
                  </select>
                </label>
              </div>
              {tracks === null && !error && <p className="muted">Chargement des titres...</p>}
              {tracks && !tracks.length && <p className="empty-state">Aucun titre pour le moment. Revenez bientôt.</p>}
              {tracks?.length > 0 && !list.length && (
                <p className="empty-state">
                  {tab === "favoris" && !query ? "Vos titres likés apparaîtront ici. Utilisez le cœur sur un morceau pour l’ajouter." : `Aucun titre trouvé${query ? ` pour « ${query} »` : ""}.`}
                </p>
              )}

              {list.length > 0 && (
                <ul className="tracklist">
                  <li className="track-head" aria-hidden="true"><span>#</span><span>Titre</span><span>Votre note</span><span>Durée</span></li>
                  {list.map((t, i) => {
                    const on = t.id === currentId;
                    const liked = favorites.includes(t.id);
                    return (
                      <li key={t.id} className={`row ${on ? "on" : ""}`} onClick={() => playTrack(t)}>
                        <span className="track-index">{on && playing ? <span className="playing-bars">▮▮</span> : i + 1}</span>
                        <button className="play" aria-label={on && playing ? `Pause ${t.title}` : `Lire ${t.title}`}
                          onClick={(e) => { e.stopPropagation(); playTrack(t); }}>
                          {on && playing ? <PauseIcon /> : <PlayIcon />}
                        </button>
                        <Cover url={t.cover_url} />
                        <div className="info">
                          <strong>{t.title}</strong>
                          <span>{[t.artist, t.album].filter(Boolean).join(" · ")}</span>
                        </div>
                        <div className="rating">
                          <Stars avg={t.rating_avg} mine={t.my_rating} onRate={(n) => rate(t, n)} />
                          <small>
                            {t.my_rating ? `Votre note : ${t.my_rating}` :
                              t.rating_count ? `${String(t.rating_avg).replace(".", ",")} (${t.rating_count})` : "Pas encore noté"}
                          </small>
                        </div>
                        <button className={`like-button ${liked ? "liked" : ""}`} aria-label={liked ? `Retirer ${t.title} des titres likés` : `Ajouter ${t.title} aux titres likés`}
                          aria-pressed={liked} onClick={(e) => { e.stopPropagation(); toggleFavorite(t.id); }}>
                          {liked ? "♥" : "♡"}
                        </button>
                        <span className="time">{fmt(t.duration)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </main>
      </div>

      {/* Lecteur : un seul élément audio pour tout le site */}
      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => step(1)}
        onError={() => setError("Ce fichier audio est momentanément indisponible.")}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
      />
      <div className={`player ${current ? "show" : ""}`} aria-hidden={!current} inert={!current}>
        <div className="player-in">
          <div className="now">
            <Cover url={current?.cover_url} size="small" />
            <div className="info">
              <strong>{current?.title}</strong>
              <span>{current?.artist}</span>
            </div>
            {current && (
              <button className={`like-button player-like ${favorites.includes(current.id) ? "liked" : ""}`}
                aria-label={favorites.includes(current.id) ? "Retirer des titres likés" : "Ajouter aux titres likés"}
                aria-pressed={favorites.includes(current.id)} onClick={() => toggleFavorite(current.id)}>
                {favorites.includes(current.id) ? "♥" : "♡"}
              </button>
            )}
          </div>
          <div className="ctl">
            <button className="ghost" onClick={() => step(-1)} aria-label="Précédent" disabled={list.length < 2}><PrevIcon /></button>
            <button className="play big" onClick={() => current && playTrack(current)} aria-label={playing ? "Pause" : "Lecture"}>
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="ghost" onClick={() => step(1)} aria-label="Suivant" disabled={list.length < 2}><NextIcon /></button>
          </div>
          <input className="volume" type="range" min="0" max="1" step="0.01" value={volume}
            onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
          <div className="seek">
            <span>{fmt(time)}</span>
            <input type="range" min="0" max={total || 1} step="0.1" value={Math.min(time, total || 1)}
              onChange={(e) => { audioRef.current.currentTime = Number(e.target.value); setTime(Number(e.target.value)); }}
              aria-label="Position" />
            <span>{fmt(total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
