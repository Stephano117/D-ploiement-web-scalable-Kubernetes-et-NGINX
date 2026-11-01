// Espace du studio (/admin) : connexion, import de musiques, gestion des titres.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, setToken } from "./api.js";

const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
const fmtBytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} Gio`;

// ======================================================= Connexion
function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(email, password);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <img src="/logo.jpg" alt="RGM" />
      <h1>Espace studio</h1>
      <label>Email
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <label>Mot de passe
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="notice" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? "Connexion..." : "Se connecter"}</button>
    </form>
  );
}

// ======================================================= Ligne d'un titre
function TrackRow({ track, onChange, onError }) {
  const [title, setTitle] = useState(track.title);
  const [album, setAlbum] = useState(track.album);
  const [published, setPublished] = useState(track.published);
  const coverInput = useRef(null);

  useEffect(() => setPublished(track.published), [track.published]);

  async function save(patch) {
    try { onChange(await api.update(track.id, patch)); } catch (e) { setPublished(track.published); onError(e); }
  }
  async function newCover(file) {
    if (!file) return;
    try { onChange(await api.cover(track.id, file)); } catch (e) { onError(e); }
  }
  return (
    <li className="arow">
      <button className="coverbtn" onClick={() => coverInput.current.click()} title="Changer la pochette" aria-label="Changer la pochette">
        {track.cover_url ? <img className="cover" src={track.cover_url} alt="" /> : <div className="cover empty">RGM</div>}
      </button>
      <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => newCover(e.target.files[0])} />
      <div className="fields">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titre"
          onBlur={() => title.trim() && title !== track.title && save({ title: title.trim() })} />
        <input value={album} placeholder="Projet ou album" onChange={(e) => setAlbum(e.target.value)} aria-label="Album"
          onBlur={() => album !== track.album && save({ album })} />
      </div>
      <div className="meta">
        <span>{fmt(track.duration)}</span>
        <span>{track.plays} écoute{track.plays > 1 ? "s" : ""}</span>
        <span>{track.rating_count ? `★ ${String(track.rating_avg).replace(".", ",")} (${track.rating_count})` : "Pas de note"}</span>
      </div>
      <label className="switch">
        <input type="checkbox" checked={published}
          onChange={(e) => { setPublished(e.target.checked); save({ published: e.target.checked }); }} />
        <span>{published ? "Publié" : "Brouillon"}</span>
      </label>
    </li>
  );
}

// ======================================================= Page
export default function Admin() {
  const [logged, setLogged] = useState(Boolean(getToken()));
  const [tracks, setTracks] = useState(null);
  const [storage, setStorage] = useState(null);
  const [message, setMessage] = useState(null);   // { text, ok }
  const [progress, setProgress] = useState(null);   // null = pas d'envoi en cours
  const [over, setOver] = useState(false);
  const fileInput = useRef(null);

  const logout = useCallback(() => { setToken(null); setLogged(false); setTracks(null); }, []);
  const fail = useCallback((e) => (e.status === 401 ? logout() : setMessage({ text: e.message })), [logout]);

  const load = useCallback(() => {
    api.adminTracks().then(setTracks).catch(fail);
    api.adminStorage().then(setStorage).catch(fail);
  }, [fail]);

  useEffect(() => { if (logged) load(); }, [logged, load]);

  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setMessage(null);
    setProgress(0);
    try {
      const res = await api.upload(files, setProgress);
      if (res.errors?.length) setMessage({ text: res.errors.map((e) => `${e.file} : ${e.error}`).join(" · ") });
      else setMessage({ ok: true, text: `${res.created.length} titre${res.created.length > 1 ? "s" : ""} importé${res.created.length > 1 ? "s" : ""}.` });
      load();
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!logged) return <div className="admin"><Login onDone={() => setLogged(true)} /></div>;

  return (
    <div className="admin">
      <header className="admin-top">
        <strong>RGM <span>Espace studio</span></strong>
        <div>
          <a href="/" className="btn">Voir le site</a>
          <button className="btn" onClick={logout}>Déconnexion</button>
        </div>
      </header>

      <main className="admin-main">
        <label
          className={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
        >
          <strong>Importer des musiques</strong>
          <span>Déposez vos fichiers ici ou touchez pour les choisir (mp3, wav, flac, m4a, aac, ogg)</span>
          <input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={(e) => upload(e.target.files)} />
          {progress !== null && (
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div style={{ width: `${progress * 100}%` }} />
              <small>{progress >= 1 ? "Conversion en cours..." : `${Math.round(progress * 100)} %`}</small>
            </div>
          )}
        </label>

        {storage?.tracked && (
          <p className={`notice ${storage.warning ? "" : "ok"}`} role={storage.warning ? "alert" : "status"}>
            Stockage des morceaux : {fmtBytes(storage.usedBytes)} utilisés sur {fmtBytes(storage.limitBytes)}.
            {storage.warning
              ? " L'espace commence à se remplir. Aucun morceau ne sera supprimé automatiquement ; les nouveaux imports seront refusés si l'espace réservé est atteint."
              : " Les morceaux importés sont conservés ; aucun nettoyage automatique n'est effectué."}
          </p>
        )}

        {message && <p className={`notice ${message.ok ? "ok" : ""}`} role="status">{message.text}</p>}

        <h2>Vos titres {tracks && <small>{tracks.length}</small>}</h2>
        {tracks === null && <p className="muted">Chargement...</p>}
        {tracks && !tracks.length && <p className="muted">Aucun titre. Importez votre première musique ci-dessus.</p>}
        <ul className="alist">
          {(tracks || []).map((t) => (
            <TrackRow
              key={t.id} track={t} onError={fail}
              onChange={(u) => setTracks((all) => all.map((x) => (x.id === u.id ? u : x)))}
            />
          ))}
        </ul>
      </main>
    </div>
  );
}
